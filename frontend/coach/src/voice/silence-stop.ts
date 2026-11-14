/** Local signal energy only. No transcript, recording or audio leaves this helper. */
export function stopAfterSpeechPause(stream:MediaStream,stop:()=>void):()=>void {
 let context:AudioContext|undefined,timer:ReturnType<typeof setInterval>|undefined;
 try {
  context=new AudioContext();const source=context.createMediaStreamSource(stream),analyser=context.createAnalyser();analyser.fftSize=1024;source.connect(analyser);
  const values=new Float32Array(analyser.fftSize);let voiced=0,lastVoice=performance.now();
  timer=setInterval(()=>{analyser.getFloatTimeDomainData(values);const rms=Math.sqrt(values.reduce((sum,v)=>sum+v*v,0)/values.length),now=performance.now();if(rms>0.015){voiced+=100;lastVoice=now;}else if(voiced>=300 && now-lastVoice>=1400){clearInterval(timer);stop();}},100);
 }catch{/* Unsupported devices retain the explicit Stop control and recording limit. */}
 return ()=>{clearInterval(timer);void context?.close().catch(()=>{});};
}
