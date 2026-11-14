import {timingSafeEqual} from "node:crypto";
import {isIPv4} from "node:net";
export function privateHTTPSOrigin(value) {
  try {const url=new URL(value),[a,b]=url.hostname.split(".").map(Number);return url.origin===value && url.protocol==="https:" && isIPv4(url.hostname) && (a===10 || a===192&&b===168 || a===172&&b>=16&&b<=31);} catch {return false;}
}
export function phoneCookieMatches(cookie,secret) {
  if(typeof secret!=="string" || !/^[a-f0-9]{64}$/.test(secret)) return false;
  const value=(cookie??"").split(";").map(item=>item.trim()).find(item=>item.startsWith("__Host-coach-evaluation="))?.slice("__Host-coach-evaluation=".length);
  return typeof value==="string" && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value),Buffer.from(secret));
}
