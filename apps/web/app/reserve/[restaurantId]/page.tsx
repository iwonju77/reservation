import {z} from "zod";
import {notFound} from "next/navigation";
import {ReservationFlow} from "./reservation-flow";
export default async function Page({params}:{params:Promise<{restaurantId:string}>}){const id=z.string().uuid().safeParse((await params).restaurantId);if(!id.success)notFound();return <ReservationFlow restaurantId={id.data}/>;}
