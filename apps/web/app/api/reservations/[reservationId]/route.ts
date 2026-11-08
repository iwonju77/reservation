import {cancelCustomerReservation,changeCustomerReservation,getCustomerReservation,ReservationError} from "@reservation/reservation-engine";
import {NextResponse,type NextRequest} from "next/server";
import {z} from "zod";
import {assertSameOrigin} from "../../../../lib/auth-http";
import {database} from "../../../../lib/database";
import {reservationErrorResponse} from "../../../../lib/reservation-http";
const id=async(route:{params:Promise<{reservationId:string}>})=>z.string().uuid().parse((await route.params).reservationId);
const token=(r:NextRequest)=>{const value=r.headers.get("authorization");if(!value?.startsWith("Bearer "))throw new ReservationError("FORBIDDEN","Reservation access token is missing");return value.slice(7);};
export async function GET(r:NextRequest,route:{params:Promise<{reservationId:string}>}){try{return NextResponse.json(await getCustomerReservation({pool:database,reservationId:await id(route),token:token(r)}));}catch(e){return reservationErrorResponse(e);}}
export async function DELETE(r:NextRequest,route:{params:Promise<{reservationId:string}>}){const origin=assertSameOrigin(r);if(origin)return origin;try{const body=z.object({expectedVersion:z.number().int().positive(),reason:z.string().max(500).optional()}).parse(await r.json());return NextResponse.json(await cancelCustomerReservation({pool:database,reservationId:await id(route),token:token(r),...body}));}catch(e){return reservationErrorResponse(e);}}
export async function PATCH(r:NextRequest,route:{params:Promise<{reservationId:string}>}){const origin=assertSameOrigin(r);if(origin)return origin;try{const body=z.object({expectedVersion:z.number().int().positive(),businessDate:z.string().date(),startsAt:z.string().datetime(),partySize:z.number().int().positive().max(100)}).parse(await r.json());return NextResponse.json(await changeCustomerReservation({pool:database,reservationId:await id(route),token:token(r),...body,startsAt:new Date(body.startsAt)}));}catch(e){return reservationErrorResponse(e);}}
