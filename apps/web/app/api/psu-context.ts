import {createHmac} from "node:crypto";
import {isIP} from "node:net";

/** One configured ngrok edge, loopback-only Next/API. Never trust the first XFF
 * entry: ngrok APPENDS its verified value. Other deployments must supply their
 * own verified ingress adapter; an arbitrary forwarding chain is not trusted.
 */
export function psuContext(headers:Headers,endpoint:string,method:string) {
  const secret=process.env.MONEYLENS_PSU_PROXY_SECRET;
  const origin=process.env.MONEYLENS_APP_ORIGIN;
  if(!secret || secret.length<32 || process.env.MONEYLENS_PSU_INGRESS!=="ngrok" || !origin)return null;
  const url=new URL(origin);
  const last=(name:string)=>headers.get(name)?.split(",").at(-1)?.trim();
  if(url.protocol!=="https:" || !url.hostname.endsWith(".ngrok-free.dev") ||
    headers.get("host")!==url.host || last("x-forwarded-proto")!=="https")return null;
  const ip=last("x-forwarded-for"),agent=headers.get("user-agent");
  if(!ip || !isIP(ip) || !agent || agent.length>2048 || /[^\x20-\x7e]/.test(agent))return null;
  const psu:Record<string,string>={"Psu-Ip-Address":ip,"Psu-User-Agent":agent};
  for(const [input,output] of [["accept","Psu-Accept"],["accept-language","Psu-Accept-Language"]]){
    const value=headers.get(input);
    if(value && value.length<=2048 && !/[^\x20-\x7e]/.test(value))psu[output]=value;
  }
  const raw=JSON.stringify({time:Math.floor(Date.now()/1000),method,path:endpoint,
    session:headers.get("x-moneylens-session-id"),headers:psu});
  return {raw,signature:createHmac("sha256",secret).update(raw).digest("hex")};
}
