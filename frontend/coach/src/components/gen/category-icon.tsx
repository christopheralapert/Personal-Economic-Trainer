import {createElement} from "react";
import {Bus,HeartPulse,Laptop,Shirt,Ticket,Plane,TrendingUp,Zap,Phone,Shield,Briefcase,Car,Utensils,Coffee,Home,ShoppingBasket,Wrench,ArrowLeftRight,Ellipsis,CircleHelp,type LucideIcon} from "lucide-react";
import {cva} from "class-variance-authority";
const icons:Record<string,LucideIcon>={transport:Bus,health:HeartPulse,home_tech:Laptop,lifestyle:Shirt,entertainment:Ticket,travel:Plane,investment:TrendingUp,utilities:Zap,phone:Phone,insurance:Shield,salary:Briefcase,unknown:CircleHelp,taxi:Car,dining:Utensils,coffee:Coffee,housing:Home,groceries:ShoppingBasket,repairs:Wrench,transfer:ArrowLeftRight};
export const categoryGlyph=(category:string)=>Object.hasOwn(icons,category) ? icons[category] : Ellipsis;
export const categoryTone=(category:string)=>({transport:"transport",health:"misc",home_tech:"home",lifestyle:"leisure",entertainment:"coffee",travel:"transport",investment:"misc",taxi:"transport",dining:"food",coffee:"coffee",housing:"home",groceries:"leisure",repairs:"misc",utilities:"misc",phone:"transport",insurance:"misc",salary:"misc",transfer:"misc"}[category]??"unknown");
const circle=cva("inline-flex shrink-0 items-center justify-center rounded-full",{variants:{
  tone:{transport:"bg-cat-transport-bg text-cat-transport",food:"bg-cat-food-bg text-cat-food",coffee:"bg-cat-coffee-bg text-cat-coffee",home:"bg-cat-home-bg text-cat-home",leisure:"bg-cat-leisure-bg text-cat-leisure",misc:"bg-cat-misc-bg text-cat-misc",unknown:"bg-cat-unknown-bg text-cat-unknown"},
  size:{normal:"size-10",dense:"size-9"}},defaultVariants:{tone:"unknown",size:"normal"}});
export function CategoryIcon({category,size="normal"}:{category:string;size?:"normal"|"dense"}) {
  const Icon=categoryGlyph(category),tone=categoryTone(category) as "transport"|"food"|"coffee"|"home"|"leisure"|"misc"|"unknown";
  return <span className={circle({tone,size})} aria-hidden="true">{createElement(Icon,{className:"size-5"})}</span>;
}
