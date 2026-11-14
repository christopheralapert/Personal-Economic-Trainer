// Documented generateContent response shape; synthetic test data only.
export async function mockGeminiFetch(url,init) {
  if(String(url)!=="https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent") throw new Error("Unexpected mock endpoint");
  const body=JSON.parse(init.body);
  if(body.toolConfig?.functionCallingConfig?.mode!=="ANY" || !body.tools?.[0]?.functionDeclarations?.some(item=>item.name==="showTransactions") || body.generationConfig?.maxOutputTokens!==2048 || body.generationConfig?.thinkingConfig?.thinkingLevel!=="MINIMAL") throw new Error("Unexpected mock request");
  if(process.env.MONEY_COACH_GEMINI_MOCK_MAX==="true") return Response.json({candidates:[{finishReason:"MAX_TOKENS"}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:2028,totalTokenCount:2148}});
  if(process.env.MONEY_COACH_GEMINI_MOCK_MISSING==="true") return Response.json({candidates:[{content:{role:"model",parts:[{text:"No tool"}]},finishReason:"STOP",index:0}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:25,totalTokenCount:125}});
  return Response.json({candidates:[{content:{role:"model",parts:[{functionCall:{name:"showTransactions",args:{period:{start:"2026-08-01",end:"2026-09-01"},category:"taxi"}}}]},finishReason:"STOP",index:0}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:15,thoughtsTokenCount:10,totalTokenCount:125}});
}
