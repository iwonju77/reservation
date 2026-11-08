export class StaffOperationError extends Error {
  constructor(public readonly code:"NOT_FOUND"|"INVALID_TRANSITION"|"VERSION_CONFLICT"|"NOT_AVAILABLE"|"INVALID_REQUEST",message:string,public readonly details?:unknown){super(message);this.name="StaffOperationError";}
}
