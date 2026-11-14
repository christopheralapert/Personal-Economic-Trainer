import Link from "next/link";
import styles from "./legal-page.module.css";

/** Public links only; safe to compose in both server and private client layouts. */
export function LegalLinks({includeHome=false}:{includeHome?:boolean}) {
  return <nav className={styles.links} aria-label="Legal information">
    {includeHome&&<Link href="/">Home</Link>}
    <Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link>
  </nav>;
}
