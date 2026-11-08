import {notFound} from "next/navigation";
import {z} from "zod";
import {ManageReservation} from "./manage-reservation";
export default async function Page({params}:{params:Promise<{reservationId:string}>}){const id=z.string().uuid().safeParse((await params).reservationId);if(!id.success)notFound();return <ManageReservation reservationId={id.data}/>;}
