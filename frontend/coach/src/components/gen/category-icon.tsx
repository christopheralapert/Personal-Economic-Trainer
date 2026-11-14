import {createElement} from "react";
import {Bus,HeartPulse,Laptop,Shirt,Ticket,Plane,TrendingUp,Zap,Phone,Shield,Briefcase,Car,Utensils,Coffee,Home,ShoppingBasket,Wrench,ArrowLeftRight,Ellipsis,CircleHelp,type LucideIcon} from "lucide-react";
import {cva} from "class-variance-authority";
const icons:Record<string,LucideIcon>={transport:Bus,health:HeartPulse,home_tech:Laptop,lifestyle:Shirt,entertainment:Ticket,travel:Plane,investment:TrendingUp,utilities:Zap,phone:Phone,insurance:Shield,salary:Briefcase,unknown:CircleHelp,unclassified:CircleHelp,taxi:Car,dining:Utensils,coffee:Coffee,housing:Home,groceries:ShoppingBasket,repairs:Wrench,transfer:ArrowLeftRight};
export const categoryGlyph=(category:string)=>Object.hasOwn(icons,category) ? icons[category] : Ellipsis;

/** Colour slots in donut ring order. Every category maps to exactly one slot, so its colour never depends on rank. */
export const categoryTones=["groceries","lifestyle","utilities","housing","dining","transport","entertainment","health","hometech","coffee","travel","taxi","rollup","none"] as const;
export type CategoryTone=typeof categoryTones[number];
const toneOf:Record<string,CategoryTone>={groceries:"groceries",lifestyle:"lifestyle",utilities:"utilities",phone:"utilities",insurance:"utilities",housing:"housing",dining:"dining",transport:"transport",entertainment:"entertainment",health:"health",home_tech:"hometech",repairs:"hometech",coffee:"coffee",travel:"travel",taxi:"taxi",unclassified:"none",unknown:"none"};
/** `null` is the rolled-up remainder of smaller categories. Unlisted categories share the rollup slate, never the "Not categorised" grey. */
export const categoryTone=(category:string|null):CategoryTone=>category===null ? "rollup" : Object.hasOwn(toneOf,category) ? toneOf[category] : "rollup";
export const categoryRingIndex=(category:string|null)=>categoryTones.indexOf(categoryTone(category));

const circle=cva("inline-flex shrink-0 items-center justify-center rounded-full",{variants:{
  tone:{groceries:"bg-cat-groceries/15 text-cat-groceries",lifestyle:"bg-cat-lifestyle/15 text-cat-lifestyle",utilities:"bg-cat-utilities/15 text-cat-utilities",housing:"bg-cat-housing/15 text-cat-housing",
    dining:"bg-cat-dining/15 text-cat-dining",transport:"bg-cat-transport/15 text-cat-transport",entertainment:"bg-cat-entertainment/15 text-cat-entertainment",health:"bg-cat-health/15 text-cat-health",
    hometech:"bg-cat-hometech/15 text-cat-hometech",coffee:"bg-cat-coffee/15 text-cat-coffee",travel:"bg-cat-travel/15 text-cat-travel",taxi:"bg-cat-taxi/15 text-cat-taxi",
    rollup:"bg-cat-rollup/15 text-cat-rollup",none:"bg-hatch text-ink"},
  size:{normal:"size-10",dense:"size-9"}},defaultVariants:{tone:"rollup",size:"normal"}});
/** Small solid swatch used next to legend rows; hatched for "Not categorised". */
const swatch=cva("inline-block size-3 shrink-0 rounded-full",{variants:{tone:{groceries:"bg-cat-groceries",lifestyle:"bg-cat-lifestyle",utilities:"bg-cat-utilities",housing:"bg-cat-housing",dining:"bg-cat-dining",transport:"bg-cat-transport",
  entertainment:"bg-cat-entertainment",health:"bg-cat-health",hometech:"bg-cat-hometech",coffee:"bg-cat-coffee",travel:"bg-cat-travel",taxi:"bg-cat-taxi",rollup:"bg-cat-rollup",none:"bg-hatch"}},defaultVariants:{tone:"rollup"}});
export function CategoryIcon({category,size="normal"}:{category:string|null;size?:"normal"|"dense"}) {
  return <span className={circle({tone:categoryTone(category),size})} aria-hidden="true">{createElement(category===null ? Ellipsis : categoryGlyph(category),{className:"size-5"})}</span>;
}
export function CategorySwatch({category}:{category:string|null}) {return <span className={swatch({tone:categoryTone(category)})} aria-hidden="true"/>;}
