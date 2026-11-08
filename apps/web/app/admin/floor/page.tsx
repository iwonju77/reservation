import { AuthError,authorizeRestaurant } from "@reservation/auth";
import { sessionSecret } from "@reservation/shared";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { SESSION_COOKIE } from "../../../lib/auth-http";
import { database } from "../../../lib/database";
import { FloorBoard } from "./floor-board";
export default async function Page({searchParams}:{searchParams:Promise<{restaurantId?:string}>}){const id=z.string().uuid().safeParse((await searchParams).restaurantId);const token=(await cookies()).get(SESSION_COOKIE)?.value;if(!id.success||!token)redirect("/login");try{await authorizeRestaurant({pool:database,token,secret:sessionSecret(),restaurantId:id.data,minimumRole:"STAFF"});return <FloorBoard restaurantId={id.data}/>;}catch(e){if(e instanceof AuthError)redirect("/login");throw e;}}
