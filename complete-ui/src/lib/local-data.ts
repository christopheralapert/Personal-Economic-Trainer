/** Delete only this app's local values, preserving unrelated same-origin applications. */
export function clearCoachStorage(storage:Pick<Storage,"length"|"key"|"removeItem">):void {
 const owned:string[]=[];for(let index=0;index<storage.length;index++){const key=storage.key(index);if(key?.startsWith("money-coach-"))owned.push(key);}
 for(const key of owned)storage.removeItem(key);
}
