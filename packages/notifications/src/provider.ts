import {randomUUID} from "node:crypto";
export type SendMessage={to:string;body:string;idempotencyKey:string};
export interface NotificationProvider{name:string;send(message:SendMessage):Promise<{messageId:string;status:"SENT"|"UNKNOWN"}>;}
export class FakeNotificationProvider implements NotificationProvider{name="fake";sent:SendMessage[]=[];async send(message:SendMessage){this.sent.push(message);return {messageId:`fake-${randomUUID()}`,status:"SENT" as const};}}
