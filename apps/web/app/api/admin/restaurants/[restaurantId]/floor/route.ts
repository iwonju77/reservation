import { AuthError } from "@reservation/auth";
import { sessionSecret } from "@reservation/shared";
import { createStaffReservation,extendReservation,getDayBoard,modifyReservation,reassignReservation,StaffOperationError,transitionReservation } from "@reservation/staff-operations";
import { NextResponse,type NextRequest } from "next/server";
import { z } from "zod";
import { assertSameOrigin,authErrorResponse,SESSION_COOKIE } from "../../../../../../lib/auth-http";
import { database } from "../../../../../../lib/database";

const command=z.discriminatedUnion("action",[
 z.object({action:z.literal("CREATE"),idempotencyKey:z.string().min(1).max(200),businessDate:z.string().date(),startsAt:z.string().datetime(),partySize:z.number().int().positive(),customerName:z.string().trim().min(1),customerPhone:z.string().max(50).optional(),walkIn:z.boolean().optional()}),
 z.object({action:z.enum(["APPROVE","REJECT","ARRIVE","SEAT","COMPLETE","NO_SHOW","RECOVER_NO_SHOW"]),reservationId:z.string().uuid(),expectedVersion:z.number().int().positive(),reason:z.string().max(500).optional()}),
 z.object({action:z.literal("REASSIGN"),reservationId:z.string().uuid(),expectedVersion:z.number().int().positive(),tableIds:z.array(z.string().uuid()).min(1),reason:z.string().min(1).max(500)}),
 z.object({action:z.literal("EXTEND"),reservationId:z.string().uuid(),expectedVersion:z.number().int().positive(),endsAt:z.string().datetime(),reason:z.string().min(1).max(500)}),
 z.object({action:z.literal("MODIFY"),reservationId:z.string().uuid(),expectedVersion:z.number().int().positive(),businessDate:z.string().date(),startsAt:z.string().datetime(),partySize:z.number().int().positive(),tableIds:z.array(z.string().uuid()).min(1),reason:z.string().min(1).max(500)}),
]);
function response(error:unknown){if(error instanceof AuthError)return authErrorResponse(error);if(error instanceof StaffOperationError)return NextResponse.json({error:{code:error.code,message:error.message,details:error.details}},{status:error.code==="NOT_FOUND"?404:error.code==="VERSION_CONFLICT"||error.code==="NOT_AVAILABLE"?409:400});return authErrorResponse(error);}
async function base(request:NextRequest,route:{params:Promise<{restaurantId:string}>}){const token=request.cookies.get(SESSION_COOKIE)?.value;if(!token)throw new AuthError("UNAUTHENTICATED","Missing session");return {pool:database,actorToken:token,secret:sessionSecret(),restaurantId:z.string().uuid().parse((await route.params).restaurantId)};}
export async function GET(request:NextRequest,route:{params:Promise<{restaurantId:string}>}){try{const b=await base(request,route);const date=z.string().date().parse(request.nextUrl.searchParams.get("businessDate"));return NextResponse.json(await getDayBoard({...b,businessDate:date,search:request.nextUrl.searchParams.get("search")??undefined,status:request.nextUrl.searchParams.get("status")??undefined}));}catch(e){return response(e);}}
export async function POST(request:NextRequest,route:{params:Promise<{restaurantId:string}>}){const origin=assertSameOrigin(request);if(origin)return origin;try{const b=await base(request,route);const parsed=command.safeParse(await request.json());if(!parsed.success)return NextResponse.json({error:{code:"INVALID_INPUT",message:"현장 작업 정보를 확인해주세요."}},{status:400});const v=parsed.data;
 if(v.action==="CREATE")return NextResponse.json(await createStaffReservation({...b,...v,startsAt:new Date(v.startsAt)}),{status:201});
 if(v.action==="REASSIGN")return NextResponse.json(await reassignReservation({...b,...v}));
 if(v.action==="EXTEND")return NextResponse.json(await extendReservation({...b,...v,endsAt:new Date(v.endsAt)}));
 if(v.action==="MODIFY")return NextResponse.json(await modifyReservation({...b,...v,startsAt:new Date(v.startsAt)}));
 return NextResponse.json(await transitionReservation({...b,reservationId:v.reservationId,expectedVersion:v.expectedVersion,action:v.action,reason:v.reason}));
 }catch(e){return response(e);}}
