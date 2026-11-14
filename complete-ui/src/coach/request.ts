/** Bounds apply before parsing or executing any coach tool. No request text is logged. */
export const MAX_REQUEST_BYTES=65536;
export const BODY_TIMEOUT_MS=5000;

export class CoachRequestError extends Error {
  constructor(readonly status:number) {super("Invalid coach request");}
}

export async function readCoachJSON(request:Request):Promise<unknown> {
  const type=request.headers.get("content-type") ?? "";
  if(!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(type)) throw new CoachRequestError(415);
  const encoding=request.headers.get("content-encoding");
  if(encoding && encoding.toLowerCase()!=="identity") throw new CoachRequestError(415);
  const length=request.headers.get("content-length");
  if(length!==null) {
    if(!/^\d+$/.test(length)) throw new CoachRequestError(400);
    if(BigInt(length)>BigInt(MAX_REQUEST_BYTES)) throw new CoachRequestError(413);
  }
  if(request.signal.aborted) throw new CoachRequestError(400);
  const reader=request.body?.getReader();if(!reader) throw new CoachRequestError(400);
  let timer:ReturnType<typeof setTimeout>|undefined;
  let abort=()=>{};
  const deadline=new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(new CoachRequestError(408)),BODY_TIMEOUT_MS);
    abort=()=>reject(new CoachRequestError(400));
    request.signal.addEventListener("abort",abort,{once:true});
  });
  try {
    const chunks:Uint8Array[]=[];let size=0;
    while(true) {
      const {done,value}=await Promise.race([reader.read(),deadline]);
      if(done) break;
      size+=value.byteLength;if(size>MAX_REQUEST_BYTES) throw new CoachRequestError(413);
      chunks.push(value);
    }
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));
  } catch(error) {
    // Cancellation may itself hang on an uncooperative sender. Never await it.
    void reader.cancel().catch(()=>{});
    if(error instanceof CoachRequestError) throw error;
    throw new CoachRequestError(400);
  } finally {
    clearTimeout(timer);request.signal.removeEventListener("abort",abort);reader.releaseLock();
  }
}
