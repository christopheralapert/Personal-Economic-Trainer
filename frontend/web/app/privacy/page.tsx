import type { Metadata } from "next";
import { LegalLayout, type LegalSection } from "@web/components/legal-layout";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Privacy Policy | Money Coach",
  description: "How the Money Coach personal development prototype handles financial information and connected bank accounts.",
};

const sections: LegalSection[] = [
  { id: "scope", label: "Scope of this policy", content: <>
    <p>This notice describes the Money Coach development prototype used for private financial analysis and own-account testing, alongside a separate public synthetic demonstration. It describes the reviewed implementation, not an independently audited or publicly released banking product.</p>
    <p>This notice must be reviewed again before other people are invited to use the app, before new integrations are added, or before any public/commercial deployment.</p>
  </> },
  { id: "data", label: "What information is processed", content: <>
    <p>When you sign in or explicitly connect a supported bank, the app may process:</p>
    <ul>
      <li>Your verified sign-in identifier and internal user/account identifiers.</li>
      <li>Bank-connection status, consent information, account aliases, account types, currency, available or booked balances and synchronization timestamps.</li>
      <li>Imported booked transactions, including dates, amounts, descriptions, merchant or category details where supplied, and any spending classifications or corrections stored in the owned ledger.</li>
      <li>Saved planning assumptions, savings goals, allocations and coaching preferences when you use those features.</li>
      <li>Session and security data needed to authenticate requests, protect account access, detect errors and manage the connection.</li>
    </ul>
    <p>The current Live Banking importer is restricted to EUR accounts and a bounded recent history (requested last 90 calendar days). Coverage can be incomplete. The synthetic demonstration is a separate data source.</p>
  </> },
  { id: "purpose", label: "Why data is used", content: <>
    <p>Information is used to display connected accounts and transactions, calculate spending categories and the three coaching baskets, answer financial-analysis questions, and maintain safe access to the connected account. Bank access is initiated only when you choose a provider and authorize it.</p>
    <p>This prototype is for personal testing. Bank authorization is not permission to initiate payments. If the service is offered to other users, the operator must document the relevant GDPR legal basis and any additional notices before launch.</p>
  </> },
  { id: "providers", label: "External parties and services", content: <>
    <p>For Live Banking, Money Coach uses the <a href="https://enablebanking.com/" target="_blank" rel="noopener noreferrer">Enable Banking</a> read-only account-information API. Enable Banking and the bank or financial institution you authorize process information as part of their own authentication, authorization and account-information flows. Your identity provider also processes sign-in information if OIDC sign-in is enabled.</p>
    <p>Money Coach does not ask for your internet-banking password. The bank connector does not itself forward imported transactions to a hosted language model. Financial calculations use deterministic tools. Hosted model use is configured separately, and the default configuration blocks normal outbound model requests. If external AI, analytics, hosting or other processors are enabled later, this notice and provider disclosures must be updated before use.</p>
    <p>In the synthetic demo, when the operator explicitly enables Gemini chat and you turn Privacy mode off, Google also receives your question and validated analysis selectors to choose a financial tool. The app calculates the answer; raw transactions, account identifiers and balances are not supplied to this model. With Privacy mode on, answers use local rules without external model calls.</p>
    <p>Optional Gemini voice is disabled by default. If the server enables it and you select it with Privacy mode off, Google receives your microphone recording for transcription or an authored synthetic-demo sentence for speech generation. Money Coach holds this audio transiently and records only technical usage metadata. Private bank transactions and statements are not supplied to the voice service. Provider processing follows Google's terms; no EU processing location is claimed. With Privacy mode on, online voice is blocked and only browser-confirmed local speech support can be used.</p>
  </> },
  { id: "security", label: "Where data is held and protected", content: <>
    <p>In the reviewed private deployment, imported financial information is stored in the configured Money Coach PostgreSQL database. If native file imports are enabled, uploaded source files can also be held in configured private object storage. Bank session identifiers are held encrypted on the server; database owner/tenant access controls are intended to prevent users from accessing each other’s records.</p>
    <p>The app uses essential authentication and request-protection mechanisms, including session cookies. The Live Banking connector is read-only and is not designed to place live transactions into the public synthetic demo, browser storage, or PWA cache. No system is perfectly secure; the operator is responsible for host, database, backup and secret management.</p>
    <p>Storage location and international transfers depend on how the operator deploys the app and which providers are configured. A wider deployment requires a separate assessment of these facts and any applicable transfer safeguards.</p>
  </> },
  { id: "retention", label: "Retention and disconnection", content: <>
    <p><strong>Disconnecting a bank does not automatically delete previously imported transactions, account history, corrections or audit records.</strong> Disconnect blocks local source access. The application attempts to revoke the provider session; if remote revocation cannot be confirmed, encrypted session information may remain for a later retry while local access stays blocked.</p>
    <p>There is no self-service historical-data deletion endpoint in the reviewed implementation. Deletion or export requires an operator-assisted, reviewed procedure. No fixed automatic deletion schedule for imported financial history is configured in this prototype; data can remain in the local database until the operator carries out a controlled cleanup. Backups and legal retention needs must be assessed before a broader release.</p>
  </> },
  { id: "choices", label: "Your choices and rights", content: <>
    <p>You may choose not to connect any bank and use synthetic demo data instead. You can disconnect a bank in Money Coach and can also revoke its authorization using the bank’s own facilities. Disconnecting prevents further authorized use of that source but does not erase already imported financial history.</p>
    <p>Where data-protection law applies, you may have rights of access, correction, erasure, restriction, objection and data portability, as well as the right to contact the relevant supervisory authority. Requests concerning retained data can be sent to the operator’s data-protection email shown above. The operator must verify and respond to such requests according to applicable law.</p>
  </> },
  { id: "decisions", label: "AI guidance and financial decisions", content: <>
    <p>Financial coaching and spending estimates are informational only. Categorization may be incomplete, and imported history is treated as partial. Any safe-to-spend or safe-to-save figure is an estimate, not a guaranteed available amount. Guidance can remain blocked or require review when verified inputs are missing.</p>
    <p>The reviewed prototype does not initiate payments or make binding credit, insurance or other legally significant automated decisions.</p>
  </> },
  { id: "changes", label: "Updates to this notice", content: <>
    <p>This draft reflects the reviewed Money Coach implementation on 11 November 2026. Material changes in the treatment of bank data, external model integrations, hosting or sharing must be documented here before deployment. Contact the operator at the email above with questions.</p>
  </> },
];

export default function PrivacyPage() {
  return <LegalLayout
    current="privacy" heading="Privacy, explained."
    introduction="A clear account of which financial details the Money Coach prototype uses, what stays on your server, and what happens when you disconnect a bank."
    operatorName={process.env.MONEYLENS_LEGAL_OPERATOR_NAME?.trim() ?? ""}
    contactEmail={process.env.MONEYLENS_LEGAL_CONTACT_EMAIL?.trim() ?? ""}
    operatorLocation={process.env.MONEYLENS_LEGAL_OPERATOR_LOCATION?.trim() ?? ""}
    sections={sections}
  />;
}
