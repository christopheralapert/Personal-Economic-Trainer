import type { Metadata } from "next";
import { LegalLayout, type LegalSection } from "@web/components/legal-layout";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Terms of Use | Money Coach",
  description: "Terms for using the non-commercial Money Coach personal finance prototype.",
};

const sections: LegalSection[] = [
  { id: "overview", label: "About this prototype", content: <>
    <p>Money Coach is an independent, experimental financial-insight application for personal use and non-commercial software testing. It helps explain account activity and spending using an optional read-only bank connection and synthetic demonstration data.</p>
    <p>Money Coach is not a bank, payment service, investment adviser or licensed financial institution. It is not an official application of S-Bank or any connected bank.</p>
  </> },
  { id: "eligibility", label: "Permitted use", content: <>
    <p>Use this private instance only for accounts and information you own or are expressly authorized to access. Do not use a restricted personal-test integration on behalf of other people, businesses or a public customer base without the necessary provider agreements, authorizations and review.</p>
    <p>You remain responsible for maintaining your own devices, operating system, local deployment, login credentials and data backups. Do not share API private keys, session secrets or banking credentials.</p>
  </> },
  { id: "banking", label: "Open Banking connections", content: <>
    <p>Money Coach may connect to supported financial institutions through Enable Banking’s account-information service. Institution availability, scopes, account coverage, consent duration and data history depend on the provider and bank.</p>
    <p>Connecting requires you to complete the relevant third-party authorization steps. Money Coach does not ask for online-banking passwords and does not initiate payments or transfers. Your separate agreements with the bank and Enable Banking continue to apply.</p>
    <p>Production API access in Enable Banking’s restricted own-account mode is intended for evaluation or individual, non-commercial use of linked accounts, subject to the provider’s current terms. It is not authorization for a commercial release.</p>
  </> },
  { id: "data", label: "Financial data and accuracy", content: <>
    <p>The Live Banking importer currently supports EUR accounts, bounded recent transactions and partial account coverage. Only booked entries are imported. Spending calculations can exclude unresolved payments and credits; credits are not automatically income or refunds, and transfers and refunds require reconciliation. The accuracy and freshness of source data also depend on your bank.</p>
    <p><strong>Never rely on Money Coach alone to decide whether a payment can be made.</strong> Confirm balances, pending operations and account terms with the bank before acting. The application makes no guarantee of complete history, continuous uptime or error-free calculations.</p>
  </> },
  { id: "coaching", label: "AI insights are not financial advice", content: <>
    <p>Budgeting suggestions, category descriptions, what-if calculations and AI-generated text are informational aids, not individualized legal, tax, investment or regulated financial advice. Outputs can be wrong, incomplete or based on partial financial records.</p>
    <p>Money Coach does not independently verify all merchant categories or transaction descriptions and does not make payments for you. You are responsible for reviewing any financial decision.</p>
  </> },
  { id: "privacy", label: "Privacy and retention", content: <>
    <p>Use of connected accounts is also described in the <a href="/privacy">Money Coach Privacy Policy</a>. You can disconnect a bank to block further local source access, but this does not automatically erase previously imported transactions, balances, classifications or audits. Historical-data deletion requires a separate operator-assisted procedure in the reviewed version.</p>
    <p>The third-party authorization and identity services have their own privacy notices and terms. Review those before approving access.</p>
  </> },
  { id: "availability", label: "Experimental availability", content: <>
    <p>The prototype is provided for testing, without a promise of uninterrupted service, suitability for a specific purpose, a fixed support response time or continuous compatibility with banking APIs. The operator may pause testing, disable Live Banking or change the application to fix bugs and security issues.</p>
    <p>Nothing in these terms limits any consumer or data-protection rights that cannot lawfully be waived. Any later public or commercial version needs separately reviewed terms.</p>
  </> },
  { id: "contact", label: "Questions and changes", content: <>
    <p>For questions about this testing instance, bank access or retained records, contact the operator using the email shown in the project information above. The operator should update these terms whenever the actual features or data practices change.</p>
  </> },
];

export default function TermsPage() {
  return <LegalLayout
    current="terms" heading="Terms of use."
    introduction="The ground rules for using a personal Money Coach development instance, connecting a bank, and interpreting AI-supported money insights."
    operatorName={process.env.MONEYLENS_LEGAL_OPERATOR_NAME?.trim() ?? ""}
    contactEmail={process.env.MONEYLENS_LEGAL_CONTACT_EMAIL?.trim() ?? ""}
    operatorLocation={process.env.MONEYLENS_LEGAL_OPERATOR_LOCATION?.trim() ?? ""}
    sections={sections}
  />;
}
