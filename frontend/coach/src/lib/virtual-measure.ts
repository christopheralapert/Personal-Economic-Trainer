export function estimatedTransactionHeight():number {
 if(typeof document==="undefined")return 0;
 const style=getComputedStyle(document.documentElement);
 return parseFloat(style.getPropertyValue("--spacing-transaction-row"))*parseFloat(style.fontSize);
}
