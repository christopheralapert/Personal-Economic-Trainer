import "server-only";
import Image from "next/image";
import Link from "next/link";
import type {ReactNode} from "react";
import {LegalLinks} from "./legal-links";
import styles from "./legal-page.module.css";

export type LegalSection = {id:string;label:string;content:ReactNode};
type LegalLayoutProps = {
  heading:string;introduction:string;current:"privacy"|"terms";sections:LegalSection[];
  operatorName:string;contactEmail:string;operatorLocation:string;
};

export function LegalLayout({heading,introduction,current,sections,operatorName,contactEmail,operatorLocation}:LegalLayoutProps) {
  // Only these explicitly public operator fields reach the rendered page.
  // Reject malformed mailto targets rather than treating a nonempty value as configured.
  const email=/^[^\s@<>?&#:]+@[^\s@<>?&#:]+\.[^\s@<>?&#:]+$/.test(contactEmail)&&contactEmail.length<=254 ? contactEmail : "";
  const configured=Boolean(operatorName&&email&&operatorLocation);
  return <div className={styles.canvas}>
    <header className={styles.header}>
      <Link href="/" className={styles.brand} aria-label="Money Coach home"><Image src="/icons/icon.svg" width={32} height={32} alt=""/>Money Coach</Link>
      <nav className={styles.headerNav} aria-label="Legal pages">
        <Link href="/privacy" aria-current={current==="privacy"?"page":undefined}>Privacy</Link>
        <Link href="/terms" aria-current={current==="terms"?"page":undefined}>Terms</Link>
      </nav>
    </header>
    <main id="main" className={styles.page}>
      <div className={styles.hero}><h1>{heading}</h1><p className={styles.lede}>{introduction}</p><p className={styles.updated}>Version: 11 November 2026 / Development prototype</p></div>
      {!configured&&<div className={styles.setupWarning} role="note">
        <strong>Operator details need configuration.</strong>
        <p>Before publishing these draft disclosures, set an accurate operator name, valid contact email and location using <code>MONEYLENS_LEGAL_OPERATOR_NAME</code>, <code>MONEYLENS_LEGAL_CONTACT_EMAIL</code> and <code>MONEYLENS_LEGAL_OPERATOR_LOCATION</code> in the server environment.</p>
      </div>}
      <div className={styles.bodyGrid}>
        <aside className={styles.contents} aria-label="On this page"><h2>On this page</h2><nav>{sections.map(section=><a href={`#${section.id}`} key={section.id}>{section.label}</a>)}</nav></aside>
        <div className={styles.sections}>
          <section className={styles.operator} aria-labelledby="legal-operator-heading">
            <h2 id="legal-operator-heading">Who operates this prototype?</h2>
            <dl>
              <div><dt>Operator</dt><dd>{operatorName||"Not yet configured"}</dd></div>
              <div><dt>Location</dt><dd>{operatorLocation||"Not yet configured"}</dd></div>
              <div><dt>Data protection contact</dt><dd>{email?<a href={`mailto:${email}`}>{email}</a>:"Not yet configured"}</dd></div>
            </dl>
            <p>Money Coach is independent development software for the S-Bank challenge. It is not a bank or payment institution and does not claim official affiliation with any connected bank.</p>
          </section>
          {sections.map(section=><section id={section.id} key={section.id} className={styles.section} aria-labelledby={`${section.id}-heading`}>
            <h2 id={`${section.id}-heading`}>{section.label}</h2><div className={styles.sectionContent}>{section.content}</div>
          </section>)}
        </div>
      </div>
    </main>
    <footer className={styles.footer}><div><strong>Money Coach</strong><p>Independent financial insight prototype</p></div><LegalLinks includeHome/><small>Development and own-account testing / Version 11 November 2026</small></footer>
  </div>;
}
