"use client";
import {usePathname} from "next/navigation";
import {Component,type ReactNode} from "react";
import {MoneyCoach} from "./money-coach";
import ErrorView from "@/app/error";
class CoachBoundary extends Component<{pathname:string;children:ReactNode},{failed:boolean}> {
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 componentDidUpdate(previous:{pathname:string}){if(previous.pathname!==this.props.pathname && this.state.failed)this.setState({failed:false});}
 render(){return this.state.failed ? <ErrorView error={null} retry={()=>this.setState({failed:false})}/> : this.props.children;}
}
/** Keep local application errors recoverable without resending questions. */
export function AppShell({children}:{children:ReactNode}) {
 const pathname=usePathname();
 return pathname==="/" ? <CoachBoundary pathname={pathname}><MoneyCoach/></CoachBoundary> : children;
}
