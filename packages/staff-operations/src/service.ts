import { authorizeRestaurant,writeAuditLog } from "@reservation/auth";
import type { DatabasePool } from "@reservation/db";
import { createHold,submitHold } from "@reservation/reservation-engine";
import type { PoolClient } from "pg";
import { StaffOperationError } from "./staff-error";

type Base={pool:DatabasePool;actorToken:string;secret:Uint8Array;restaurantId:string};
async function tx<T>(pool:DatabasePool,fn:(c:PoolClient)=>Promise<T>){const c=await pool.connect();try{await c.query("BEGIN");const v=await fn(c);await c.query("COMMIT");return v;}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}
async function actor(input:Base){return authorizeRestaurant({pool:input.pool,token:input.actorToken,secret:input.secret,restaurantId:input.restaurantId,minimumRole:"STAFF"});}

export async function getDayBoard(input:Base&{businessDate:string;search?:string|undefined;status?:string|undefined}){
  await actor(input);const values:unknown[]=[input.restaurantId,input.businessDate];
  let filter="";
  if(input.search){values.push(`%${input.search}%`);filter+=` AND (r.customer_name ILIKE $${values.length} OR r.customer_phone ILIKE $${values.length} OR r.reservation_number ILIKE $${values.length})`;}
  if(input.status){values.push(input.status);filter+=` AND r.status=$${values.length}`;}
  const [reservations,tables]=await Promise.all([
    input.pool.query(`SELECT r.id,r.reservation_number,r.source,r.status,r.starts_at,r.ends_at,r.party_size,r.customer_name,r.customer_phone,r.arrived_at,r.version,
      COALESCE(array_agg(DISTINCT jsonb_build_object('id',t.id,'name',t.name)) FILTER(WHERE t.id IS NOT NULL),'{}') AS allocated_tables,
      COALESCE(bool_or(o.completed_at IS NULL) FILTER(WHERE o.id IS NOT NULL),FALSE) AS seated
      FROM reservations r LEFT JOIN reservation_allocations a ON a.reservation_id=r.id AND a.released_at IS NULL
      LEFT JOIN dining_tables t ON t.id=a.table_id LEFT JOIN table_occupancies o ON o.reservation_id=r.id
      WHERE r.restaurant_id=$1 AND r.business_date=$2 ${filter} GROUP BY r.id ORDER BY r.starts_at`,values),
    input.pool.query(`SELECT t.id,t.name,t.default_seats,t.max_seats,t.zone,t.inactive_at,
      o.reservation_id AS seated_reservation_id,r.customer_name AS seated_customer
      FROM dining_tables t LEFT JOIN table_occupancies o ON o.table_id=t.id AND o.completed_at IS NULL
      LEFT JOIN reservations r ON r.id=o.reservation_id WHERE t.restaurant_id=$1 ORDER BY t.zone,t.name`,[input.restaurantId]),
  ]);
  return {generatedAt:new Date().toISOString(),businessDate:input.businessDate,reservations:reservations.rows,tables:tables.rows};
}

export async function createStaffReservation(input:Base&{idempotencyKey:string;businessDate:string;startsAt:Date;partySize:number;customerName:string;customerPhone?:string|undefined;walkIn?:boolean|undefined;now?:Date|undefined}){
  const a=await actor(input);const owner=`staff:${a.userId}`;
  const hold=await createHold({pool:input.pool,restaurantId:input.restaurantId,ownerScope:owner,idempotencyKey:input.idempotencyKey,businessDate:input.businessDate,startsAt:input.startsAt,partySize:input.partySize,source:input.walkIn?"WALK_IN":"STAFF",bypassBookingWindow:true,now:input.now});
  await input.pool.query("UPDATE reservations SET customer_name=$2,customer_phone=$3 WHERE id=$1",[hold.reservationId,input.customerName.trim(),input.customerPhone??null]);
  return submitHold({pool:input.pool,reservationId:hold.reservationId,ownerScope:owner,expectedVersion:1,...(input.now?{now:input.now}:{})});
}

type Action="APPROVE"|"REJECT"|"ARRIVE"|"SEAT"|"COMPLETE"|"NO_SHOW"|"RECOVER_NO_SHOW";
export async function transitionReservation(input:Base&{reservationId:string;expectedVersion:number;action:Action;reason?:string|undefined}){
  const a=await actor(input);return tx(input.pool,async c=>{
    await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",[input.restaurantId]);
    const q=await c.query<{status:string;version:number}>("SELECT status,version FROM reservations WHERE id=$1 AND restaurant_id=$2 FOR UPDATE",[input.reservationId,input.restaurantId]);const r=q.rows[0];
    if(!r)throw new StaffOperationError("NOT_FOUND","Reservation was not found");if(r.version!==input.expectedVersion)throw new StaffOperationError("VERSION_CONFLICT","Reservation changed");
    const allowed:Record<Action,string[]>= {APPROVE:["PENDING_APPROVAL"],REJECT:["PENDING_APPROVAL","CONFIRMED"],ARRIVE:["CONFIRMED"],SEAT:["CONFIRMED"],COMPLETE:["SEATED"],NO_SHOW:["CONFIRMED"],RECOVER_NO_SHOW:["NO_SHOW"]};
    if(!allowed[input.action].includes(r.status))throw new StaffOperationError("INVALID_TRANSITION",`${input.action} is invalid from ${r.status}`);
    let next=r.status;
    if(input.action==="APPROVE"||input.action==="RECOVER_NO_SHOW")next="CONFIRMED";if(input.action==="REJECT")next="CANCELLED";if(input.action==="SEAT")next="SEATED";if(input.action==="COMPLETE")next="COMPLETED";if(input.action==="NO_SHOW")next="NO_SHOW";
    if(input.action==="RECOVER_NO_SHOW"){
      const old=await c.query<{table_id:string;occupied_period:string}>("SELECT DISTINCT ON(table_id) table_id,occupied_period::text FROM reservation_allocations WHERE reservation_id=$1 ORDER BY table_id,created_at DESC",[input.reservationId]);
      try{for(const row of old.rows)await c.query("INSERT INTO reservation_allocations (restaurant_id,reservation_id,table_id,occupied_period) VALUES ($1,$2,$3,$4::tstzrange)",[input.restaurantId,input.reservationId,row.table_id,row.occupied_period]);}catch(e){if(typeof e==="object"&&e&&"code" in e&&e.code==="23P01")throw new StaffOperationError("NOT_AVAILABLE","Original tables are no longer available");throw e;}
    }
    if(input.action==="ARRIVE")await c.query("UPDATE reservations SET arrived_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",[input.reservationId]);
    else await c.query("UPDATE reservations SET status=$2,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",[input.reservationId,next]);
    if(input.action==="SEAT")await c.query(`INSERT INTO table_occupancies (restaurant_id,reservation_id,table_id,seated_at) SELECT restaurant_id,reservation_id,table_id,CURRENT_TIMESTAMP FROM reservation_allocations WHERE reservation_id=$1 AND released_at IS NULL`,[input.reservationId]);
    if(["REJECT","COMPLETE","NO_SHOW"].includes(input.action)){await c.query("UPDATE reservation_allocations SET released_at=CURRENT_TIMESTAMP WHERE reservation_id=$1 AND released_at IS NULL",[input.reservationId]);if(input.action==="COMPLETE")await c.query("UPDATE table_occupancies SET completed_at=CURRENT_TIMESTAMP WHERE reservation_id=$1 AND completed_at IS NULL",[input.reservationId]);}
    await c.query("INSERT INTO reservation_events (reservation_id,event_type,actor_user_id,reason,from_status,to_status,reservation_version,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",[input.reservationId,input.action,a.userId,input.reason??null,r.status,next,r.version+1,JSON.stringify({source:"STAFF_CONSOLE"})]);
    await writeAuditLog(c,{restaurantId:input.restaurantId,actorUserId:a.userId,action:`RESERVATION_${input.action}`,targetType:"RESERVATION",targetId:input.reservationId,...(input.reason?{reason:input.reason}:{}),afterValue:{status:next,version:r.version+1}});
    return {reservationId:input.reservationId,status:next,version:r.version+1};
  });
}

export async function reassignReservation(input:Base&{reservationId:string;expectedVersion:number;tableIds:string[];reason:string}){
  const a=await actor(input);return tx(input.pool,async c=>{const r=await c.query<{version:number;status:string;period:string}>(`SELECT r.version,r.status,(SELECT occupied_period::text FROM reservation_allocations WHERE reservation_id=r.id ORDER BY created_at DESC LIMIT 1) period FROM reservations r WHERE r.id=$1 AND r.restaurant_id=$2 FOR UPDATE`,[input.reservationId,input.restaurantId]);const row=r.rows[0];if(!row)throw new StaffOperationError("NOT_FOUND","Reservation not found");if(row.version!==input.expectedVersion)throw new StaffOperationError("VERSION_CONFLICT","Reservation changed");if(row.status==="SEATED")throw new StaffOperationError("INVALID_TRANSITION","Complete seating before reassignment");
    await c.query("UPDATE reservation_allocations SET released_at=CURRENT_TIMESTAMP WHERE reservation_id=$1 AND released_at IS NULL",[input.reservationId]);try{for(const tableId of [...new Set(input.tableIds)])await c.query("INSERT INTO reservation_allocations (restaurant_id,reservation_id,table_id,occupied_period) VALUES ($1,$2,$3,$4::tstzrange)",[input.restaurantId,input.reservationId,tableId,row.period]);}catch(e){if(typeof e==="object"&&e&&"code" in e&&e.code==="23P01")throw new StaffOperationError("NOT_AVAILABLE","Selected tables are unavailable");throw e;}
    await c.query("UPDATE reservations SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",[input.reservationId]);await writeAuditLog(c,{restaurantId:input.restaurantId,actorUserId:a.userId,action:"RESERVATION_REASSIGNED",targetType:"RESERVATION",targetId:input.reservationId,reason:input.reason,afterValue:{tableIds:input.tableIds}});return {version:row.version+1};});
}

export async function extendReservation(input:Base&{reservationId:string;expectedVersion:number;endsAt:Date;reason:string}){
  const a=await actor(input);return tx(input.pool,async c=>{const q=await c.query<{version:number;ends_at:Date;cleanup_minutes:number}>(`SELECT r.version,r.ends_at,s.cleanup_minutes FROM reservations r JOIN reservation_policy_snapshots s ON s.reservation_id=r.id AND s.revision=1 WHERE r.id=$1 AND r.restaurant_id=$2 FOR UPDATE OF r`,[input.reservationId,input.restaurantId]);const r=q.rows[0];if(!r)throw new StaffOperationError("NOT_FOUND","Reservation not found");if(r.version!==input.expectedVersion)throw new StaffOperationError("VERSION_CONFLICT","Reservation changed");if(input.endsAt<=r.ends_at)throw new StaffOperationError("INVALID_REQUEST","Extension must increase end time");
    try{await c.query("UPDATE reservation_allocations SET occupied_period=tstzrange(lower(occupied_period),$2::timestamptz + ($3::text||' minutes')::interval,'[)') WHERE reservation_id=$1 AND released_at IS NULL",[input.reservationId,input.endsAt,r.cleanup_minutes]);}catch(e){if(typeof e==="object"&&e&&"code" in e&&e.code==="23P01")throw new StaffOperationError("NOT_AVAILABLE","Extension conflicts with the next reservation",{requiresContact:true});throw e;}
    await c.query("UPDATE reservations SET ends_at=$2,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",[input.reservationId,input.endsAt]);await writeAuditLog(c,{restaurantId:input.restaurantId,actorUserId:a.userId,action:"RESERVATION_EXTENDED",targetType:"RESERVATION",targetId:input.reservationId,reason:input.reason,afterValue:{endsAt:input.endsAt.toISOString()}});return {version:r.version+1};});
}

export async function modifyReservation(input:Base&{reservationId:string;expectedVersion:number;businessDate:string;startsAt:Date;partySize:number;tableIds:string[];reason:string}){
 const a=await actor(input);return tx(input.pool,async c=>{await c.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",[input.restaurantId]);
  const q=await c.query<{version:number;status:string;duration_minutes:number;cleanup_minutes:number;deposit_minor:string;revision:number}>(`SELECT r.version,r.status,s.duration_minutes,s.cleanup_minutes,s.deposit_minor,s.revision FROM reservations r JOIN LATERAL(SELECT * FROM reservation_policy_snapshots WHERE reservation_id=r.id ORDER BY revision DESC LIMIT 1)s ON TRUE WHERE r.id=$1 AND r.restaurant_id=$2 FOR UPDATE OF r`,[input.reservationId,input.restaurantId]);const r=q.rows[0];if(!r)throw new StaffOperationError("NOT_FOUND","Reservation not found");if(r.version!==input.expectedVersion)throw new StaffOperationError("VERSION_CONFLICT","Reservation changed");if(Number(r.deposit_minor)>0)throw new StaffOperationError("INVALID_REQUEST","Paid reservation changes require the payment workflow");if(!["CONFIRMED","PENDING_APPROVAL"].includes(r.status))throw new StaffOperationError("INVALID_TRANSITION","Reservation cannot be changed in its current state");
  const ids=[...new Set(input.tableIds)];const tables=await c.query<{capacity:number}>("SELECT COALESCE(sum(max_seats),0)::int capacity FROM dining_tables WHERE restaurant_id=$1 AND id=ANY($2::uuid[]) AND inactive_at IS NULL",[input.restaurantId,ids]);if(!ids.length||Number(tables.rows[0]?.capacity??0)<input.partySize)throw new StaffOperationError("INVALID_REQUEST","Selected tables do not fit the party");const endsAt=new Date(input.startsAt.getTime()+r.duration_minutes*60000),occupiedUntil=new Date(endsAt.getTime()+r.cleanup_minutes*60000);
  await c.query("UPDATE reservation_allocations SET released_at=CURRENT_TIMESTAMP WHERE reservation_id=$1 AND released_at IS NULL",[input.reservationId]);try{for(const id of ids)await c.query("INSERT INTO reservation_allocations(restaurant_id,reservation_id,table_id,occupied_period)VALUES($1,$2,$3,tstzrange($4,$5,'[)'))",[input.restaurantId,input.reservationId,id,input.startsAt,occupiedUntil]);}catch(e){if(typeof e==="object"&&e&&"code" in e&&e.code==="23P01")throw new StaffOperationError("NOT_AVAILABLE","Requested change conflicts with another reservation");throw e;}
  await c.query("UPDATE reservations SET business_date=$2,starts_at=$3,ends_at=$4,party_size=$5,seat_count=$5,chargeable_party_size=$5,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1",[input.reservationId,input.businessDate,input.startsAt,endsAt,input.partySize]);
  await c.query(`INSERT INTO reservation_policy_snapshots(reservation_id,restaurant_id,revision,policy_version_id,duration_minutes,cleanup_minutes,minimum_spend_minor,deposit_minor,currency,requires_approval,evaluation_input,evaluation_result,terms_version)
   SELECT reservation_id,restaurant_id,$2,policy_version_id,duration_minutes,cleanup_minutes,minimum_spend_minor,deposit_minor,currency,requires_approval,$3,evaluation_result,terms_version FROM reservation_policy_snapshots WHERE reservation_id=$1 AND revision=$4`,[input.reservationId,r.revision+1,JSON.stringify({businessDate:input.businessDate,startsAt:input.startsAt,partySize:input.partySize,source:"STAFF_CHANGE"}),r.revision]);
  await c.query("INSERT INTO reservation_events(reservation_id,event_type,actor_user_id,reason,from_status,to_status,reservation_version,payload)VALUES($1,'RESERVATION_CHANGED',$2,$3,$4,$4,$5,$6)",[input.reservationId,a.userId,input.reason,r.status,r.version+1,JSON.stringify({businessDate:input.businessDate,startsAt:input.startsAt,partySize:input.partySize,tableIds:ids})]);return {version:r.version+1,endsAt:endsAt.toISOString()};});
}
