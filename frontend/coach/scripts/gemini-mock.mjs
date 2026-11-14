// Documented generateContent response shape; synthetic test data only.
import {geminiCases} from "./gemini-cases.mjs";
export async function mockGeminiFetch(url,init) {
  if(String(url)!=="https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent") throw new Error("Unexpected mock endpoint");
  const body=JSON.parse(init.body);
  if(body.toolConfig?.functionCallingConfig?.mode!=="ANY" || !body.tools?.[0]?.functionDeclarations?.some(item=>item.name==="showTransactions") || body.generationConfig?.maxOutputTokens!==2048 || body.generationConfig?.thinkingConfig?.thinkingLevel!=="MINIMAL") throw new Error("Unexpected mock request");
  if(process.env.MONEY_COACH_GEMINI_MOCK_MAX==="true") return Response.json({candidates:[{finishReason:"MAX_TOKENS"}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:2028,totalTokenCount:2148}});
  if(process.env.MONEY_COACH_GEMINI_MOCK_MISSING==="true") return Response.json({candidates:[{content:{role:"model",parts:[{text:"No tool"}]},finishReason:"STOP",index:0}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:25,totalTokenCount:125}});
  const text=body.contents?.at(-1)?.parts?.[0]?.text??"";
  let question=text;try {question=JSON.parse(text).question??text;} catch {}
  const choices=geminiCases[process.env.MONEY_COACH_GEMINI_CASE??"taxi"]??[];
  const selected=choices.find(item=>item.question===question);
  if(!selected) throw new Error("Unknown mock question");
  const declaration=body.tools[0].functionDeclarations.find(item=>item.name===selected.tool),input={...selected.input,...(declaration?.parametersJsonSchema.required?.includes('nextStep')?{nextStep:'Review the matching records before choosing a habit to change.'}:{})};
  return Response.json({candidates:[{content:{role:"model",parts:[{functionCall:{name:selected.tool,args:input}}]},finishReason:"STOP",index:0}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:15,thoughtsTokenCount:10,totalTokenCount:125}});
}
