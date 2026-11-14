const calendar=new Intl.DateTimeFormat("en",{timeZone:"Europe/Helsinki",year:"numeric",month:"2-digit",day:"2-digit"});
/** Booking-date boundaries follow the Finnish source calendar, not UTC slicing. */
export function sourceDate(instant:string):string {
  const parts=calendar.formatToParts(new Date(instant));
  const value=(type:string)=>parts.find(part=>part.type===type)!.value;
  return `${value("year").padStart(4,"0")}-${value("month")}-${value("day")}`;
}
