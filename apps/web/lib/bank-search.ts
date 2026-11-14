// Search labels and local spelling aliases never replace provider consent names.
export type SearchableBank={name:string;country:string;aliases?:readonly string[]};
export function normalizeBankName(value:string){return value.normalize("NFKD").replace(/\p{M}/gu,"").toLowerCase().replace(/[^\p{L}\p{N}]/gu,"");}
const spellingAliases:Record<string,readonly (readonly [string,...string[]])[]>={
 EE:[["cooppank","Coop Bank"],["wise","Wise Personal"],["lhv","LHV Pank","LHV Bank"]],
 FI:[["spankki","S Bank","S Pankki"],["op","Osuuspankki","OP Bank"],["danskebank","Danske"]],
};
export function matchesBank(bank:SearchableBank,query:string){
 const needle=normalizeBankName(query);if(!needle)return true;
 const name=normalizeBankName(bank.name);
 const aliases=(spellingAliases[bank.country]??[]).filter(([key])=>name.startsWith(key)).flat();
 return [bank.name,...(bank.aliases??[]),...aliases].some(value=>normalizeBankName(value).includes(needle));
}
