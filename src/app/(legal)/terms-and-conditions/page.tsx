import type { Metadata } from "next";
import {
  LegalHeading,
  LegalList,
  LegalMeta,
  LegalSection,
} from "../_components/legal-content";
import {
  COMPANY_NAME,
  TERMS_EFFECTIVE_DATE as EFFECTIVE_DATE,
  PRODUCT_NAME,
  SUPPORT_EMAIL,
  WEBSITE_DOMAIN,
} from "../_constants";

export const metadata: Metadata = {
  title: "Terms and Conditions | WhatsApp Max",
  description:
    "The terms governing use of WhatsApp Max, including permitted use, integrations, data ownership, subscriptions and liability.",
};

export default function TermsAndConditionsPage() {
  return (
    <article>
      <LegalHeading>Terms and Conditions</LegalHeading>
      <LegalMeta>
        {PRODUCT_NAME} &middot; Effective date: {EFFECTIVE_DATE}
      </LegalMeta>

      <p className="mt-6 text-sm leading-relaxed text-muted-foreground">
        These Terms and Conditions (the &ldquo;Terms&rdquo;) govern your access
        to and use of {PRODUCT_NAME}{" "}(the &ldquo;Service&rdquo;) provided by
        {" "}
        {COMPANY_NAME}, available at {WEBSITE_DOMAIN}. Please read them
        carefully.
      </p>

      <LegalSection id="acceptance" title="1. Acceptance of Terms">
        <p>
          By accessing or using the Service, creating an account, or clicking to
          accept these Terms, you agree to be bound by them. If you are using
          the Service on behalf of an organisation, you represent that you have
          authority to bind that organisation, and &ldquo;you&rdquo; refers to
          that organisation. If you do not agree, do not use the Service.
        </p>
      </LegalSection>

      <LegalSection
        id="eligibility"
        title="2. Eligibility and Authorised Business Use"
      >
        <p>
          The Service is intended for business use by users who are of legal age
          to form a binding contract. You may use the Service only for lawful
          business purposes and only as permitted by these Terms and applicable
          law.
        </p>
      </LegalSection>

      <LegalSection id="account-security" title="3. Account Security">
        <p>
          You are responsible for safeguarding your account credentials and for
          all activity that occurs under your account. You must keep your
          password confidential, use appropriate security for team member
          access, and notify us promptly at{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-primary hover:text-primary/80"
          >
            {SUPPORT_EMAIL}
          </a>{" "}
          of any unauthorised use.
        </p>
      </LegalSection>

      <LegalSection
        id="permitted-prohibited-use"
        title="4. Permitted and Prohibited Use"
      >
        <p>You agree not to, and not to permit anyone else to:</p>
        <LegalList>
          <li>
            Use the Service to send spam, unlawful, deceptive, harassing or
            infringing content.
          </li>
          <li>
            Violate the terms, policies or rate limits of WhatsApp, Google or
            any other integrated platform.
          </li>
          <li>
            Reverse engineer, disrupt, overload, or attempt to gain unauthorised
            access to the Service or its infrastructure.
          </li>
          <li>
            Resell, sublicense or provide the Service to third parties except as
            expressly permitted.
          </li>
          <li>Use the Service to violate any applicable law or regulation.</li>
        </LegalList>
      </LegalSection>

      <LegalSection
        id="third-party-integrations"
        title="5. WhatsApp and Third-Party Integrations"
      >
        <p>
          The Service integrates with third-party platforms, including WhatsApp.
          Your use of those integrations is also subject to the respective
          third party&rsquo;s terms and policies. We are not responsible for
          third-party services, and their availability or behaviour may change
          or be discontinued outside our control.
        </p>
      </LegalSection>

      <LegalSection
        id="google-sheets-integration"
        title="6. Google Sheets Integration"
      >
        <p>
          The Service allows authorised users to connect a Google account and
          link or create a Google Spreadsheet for use with CRM automation flows.
        </p>
        <p>
          When configured by the user, collected flow responses may be
          automatically appended as new rows to the linked spreadsheet. Users
          may also request that previously completed responses be added to the
          spreadsheet.
        </p>
        <p>
          You are responsible for ensuring that you have the lawful authority to
          transfer customer or business information to Google Sheets and for
          controlling access to the linked spreadsheet.
        </p>
        <p>
          Your use of Google services is subject to Google&rsquo;s applicable
          terms and policies. Our use and transfer of information received from
          Google APIs will adhere to the Google API Services User Data Policy,
          including the Limited Use requirements, as explained in our Privacy
          Policy.
        </p>
      </LegalSection>

      <LegalSection
        id="customer-consent"
        title="7. User Responsibility for Obtaining Customer Consent"
      >
        <p>
          You are solely responsible for ensuring you have a lawful basis and
          all necessary consents to contact your customers and to process their
          personal data through the Service, including any consent required to
          message them on WhatsApp. You represent that your contact lists and
          messaging comply with all applicable laws.
        </p>
      </LegalSection>

      <LegalSection
        id="anti-spam"
        title="8. Messaging and Anti-Spam Compliance"
      >
        <p>
          You must comply with all applicable anti-spam, marketing and
          communications laws and regulations, as well as the messaging policies
          of WhatsApp and any other channel. This includes honouring opt-out
          requests and refraining from sending unsolicited or prohibited
          messages.
        </p>
      </LegalSection>

      <LegalSection id="data-ownership" title="9. Customer Data Ownership">
        <p>
          As between you and us, you own the customer and business data you
          submit to or generate within the Service (&ldquo;Customer
          Data&rdquo;). You grant us a limited licence to process Customer Data
          solely to provide, secure and support the Service. We process Customer
          Data in accordance with our Privacy Policy.
        </p>
      </LegalSection>

      <LegalSection
        id="subscription-payment"
        title="10. Subscription and Payment Terms"
      >
        <p>
          Paid features of the Service may be offered on a subscription basis.
          The applicable fees, billing cycle, accepted payment methods, taxes,
          and any refund or cancellation terms are those presented to you at the
          point of purchase or set out in a separate agreement. Unless stated
          otherwise, fees are due as described at the time of purchase.
        </p>
      </LegalSection>

      <LegalSection id="service-availability" title="11. Service Availability">
        <p>
          We strive to keep the Service available and reliable, but we do not
          guarantee uninterrupted or error-free operation. The Service may be
          temporarily unavailable for maintenance, updates, or reasons beyond
          our control. Any specific service-level commitments will be set out in
          a separate agreement where applicable.
        </p>
      </LegalSection>

      <LegalSection id="intellectual-property" title="12. Intellectual Property">
        <p>
          The Service, including its software, design, trademarks and content
          (excluding Customer Data), is owned by {COMPANY_NAME} or its licensors
          and is protected by intellectual-property laws. We grant you a
          limited, non-exclusive, non-transferable right to use the Service
          during your subscription. No other rights are granted.
        </p>
      </LegalSection>

      <LegalSection id="confidentiality" title="13. Confidentiality">
        <p>
          Each party may access non-public information of the other. Each party
          agrees to protect the other&rsquo;s confidential information with
          reasonable care and to use it only as necessary to perform under these
          Terms, except where disclosure is required by law.
        </p>
      </LegalSection>

      <LegalSection
        id="suspension-termination"
        title="14. Suspension and Termination"
      >
        <p>
          We may suspend or terminate your access to the Service if you breach
          these Terms, create risk or legal exposure for us, or fail to pay
          applicable fees. You may stop using the Service at any time. Upon
          termination, your right to use the Service ceases; certain provisions
          that by their nature should survive will remain in effect.
        </p>
      </LegalSection>

      <LegalSection id="disclaimers" title="15. Disclaimers">
        <p>
          The Service is provided &ldquo;as is&rdquo; and &ldquo;as
          available&rdquo; without warranties of any kind, whether express,
          implied or statutory, including implied warranties of
          merchantability, fitness for a particular purpose and
          non-infringement, to the maximum extent permitted by law.
        </p>
      </LegalSection>

      <LegalSection id="limitation-liability" title="16. Limitation of Liability">
        <p>
          To the maximum extent permitted by law, {COMPANY_NAME} will not be
          liable for any indirect, incidental, special, consequential or
          punitive damages, or for any loss of profits, revenue, data or
          goodwill, arising out of or related to your use of the Service. Our
          total aggregate liability for any claim relating to the Service is
          limited to the amount you paid us for the Service in the twelve months
          preceding the event giving rise to the claim.
        </p>
      </LegalSection>

      <LegalSection id="indemnification" title="17. Indemnification">
        <p>
          You agree to indemnify and hold harmless {COMPANY_NAME} and its
          officers, employees and agents from and against any claims, damages,
          liabilities and expenses arising out of your Customer Data, your use
          of the Service, your messaging activities, or your breach of these
          Terms or applicable law.
        </p>
      </LegalSection>

      <LegalSection
        id="changes"
        title="18. Changes to the Service and Terms"
      >
        <p>
          We may modify the Service or these Terms from time to time. When we
          make material changes to these Terms, we will update the effective
          date above and, where appropriate, provide additional notice. Your
          continued use of the Service after changes take effect constitutes
          acceptance of the updated Terms.
        </p>
      </LegalSection>

      <LegalSection id="contact" title="19. Contact Information">
        <p>
          Questions about these Terms can be sent to{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-primary hover:text-primary/80"
          >
            {SUPPORT_EMAIL}
          </a>
          .
        </p>
        <p>
          {COMPANY_NAME} &middot;{" "}
          <a
            href={WEBSITE_DOMAIN}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:text-primary/80"
          >
            {WEBSITE_DOMAIN}
          </a>
        </p>
      </LegalSection>
    </article>
  );
}
