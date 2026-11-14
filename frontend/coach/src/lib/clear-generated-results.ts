/** Remove only legacy generated outputs, never preferences or saved transactions. */
export function clearGeneratedResults(storage:Storage):void {
 try {
  const keys=Array.from({length:storage.length},(_,index)=>storage.key(index));
  for(const key of keys)if(key?.startsWith('money-coach-generated.')||key?.startsWith('money-coach-thread.'))storage.removeItem(key);
 }catch{ /* Denied storage does not prevent a fresh, memory-only conversation. */ }
}
