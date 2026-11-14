const august={start:"2026-08-01",end:"2026-09-01"},july={start:"2026-07-01",end:"2026-08-01"},september={start:"2026-09-01",end:"2026-10-01"};
export const geminiCases={
  taxi:[{question:"How much did I spend on taxis last month?",tool:"showTransactions",input:{period:august,category:"taxi"}}],
  followup:[{question:"How much did I spend on taxis last month?",tool:"showTransactions",input:{period:august,category:"taxi"}},{question:"What about the month before?",tool:"showTransactions",input:{period:july,category:"taxi"}}],
  dining:[{question:"What if I cut dining out by 20% in September 2026?",tool:"showWhatIf",input:{period:september,category:"dining",pct:20}}],
  profile:[{question:"What kind of spender am I?",tool:"showProfile",input:{period:september}}],
  spend:[{question:"What is safe for me to spend this week?",tool:"showSafeToSpend",input:{purpose:"spend"}}],
  save:[{question:"What is safe for me to save this week?",tool:"showSafeToSpend",input:{purpose:"save"}}],
  et:[{question:"Kui palju kulutasin septembris taksole?",tool:"showTransactions",input:{period:september,category:"taxi"}}],
  fi:[{question:"Paljonko käytin takseihin viime kuussa?",tool:"showTransactions",input:{period:august,category:"taxi"}}],
};
