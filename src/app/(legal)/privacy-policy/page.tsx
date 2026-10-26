import type { Metadata } from "next";
import {
  LegalHeading,
  LegalList,
  LegalMeta,
  LegalSection,
} from "../_components/legal-content";
import {
  COMPANY_NAME,
  PRIVACY_EFFECTIVE_DATE as EFFECTIVE_DATE,
  PRODUCT_NAME,
  SUPPORT_EMAIL,
  WEBSITE_DOMAIN,
} from "../_constants";

export const metadata: Metadata = {
  title: "Privacy Policy | WhatsApp Max",
  description:
    "How WhatsApp Max collects, uses, protects and shares personal information, including data accessed through Google APIs.",
};

export default function PrivacyPolicyPage() {
  return (
    <article>
      <LegalHeading>Privacy Policy — {PRODUCT_NAME}</LegalHeading>
      <LegalMeta>
        Effective date: {EFFECTIVE_DATE} &middot; Last updated:{" "}
        {EFFECTIVE_DATE} &middot; Application: {PRODUCT_NAME}
      </LegalMeta>
      <LegalMeta>
        Developer and operator: {COMPANY_NAME} &middot; Website:{" "}
        <a
          href={WEBSITE_DOMAIN}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:text-primary/80"
        >
          {WEBSITE_DOMAIN.replace(/^https?:\/\//, "")}
        </a>{" "}
        &middot; Privacy contact:{" "}
        <a
          href={`mailto:${SUPPORT_EMAIL}`}
          className="text-primary hover:text-primary/80"
        >
          {SUPPORT_EMAIL}
        </a>
      </LegalMeta>

      <LegalSection id="introduction" title="1. Introduction">
        <p>
          {COMPANY_NAME} (&ldquo;we,&rdquo; &ldquo;us,&rdquo; or
          &ldquo;our&rdquo;) operates {PRODUCT_NAME}, a customer relationship
          management (CRM) platform that helps businesses manage customer
          conversations, capture leads, and automate workflows.
        </p>
        <p>
          This Privacy Policy explains what personal and business information{" "}
          {PRODUCT_NAME} collects, what Google account and spreadsheet data
          each Google integration accesses, the exact purposes for reading,
          writing, importing, and synchronizing that data, how OAuth tokens
          and related data are stored and protected, with whom Google data
          may be shared, how long data is retained, and how users can
          disconnect integrations, revoke access, and request deletion.
        </p>
        <p>
          {PRODUCT_NAME} provides two separate Google Sheets integrations,
          each with its own OAuth grant and separately stored connection: (A)
          the Flow Tables integration for CRM automation flows, and (B) the
          Meta Lead Ads → Google Sheets integration. Google user data is
          used only to provide the spreadsheet synchronization features an
          authorized workspace user explicitly configures and enables.
        </p>
        <p>
          We process information only as described in this policy and as
          necessary to provide, maintain, secure, and improve the features
          users choose to use.
        </p>
      </LegalSection>

      <LegalSection
        id="information-we-collect"
        title="2. Information We Collect"
      >
        <p>
          Depending on the features you enable, {PRODUCT_NAME} processes the
          following categories of personal and business data:
        </p>
        <LegalList>
          <li>
            <strong>Account information:</strong> Name, email address,
            authentication credentials, organisation name, team membership,
            role assignments, and account and workspace settings, provided
            during registration, invitation, and administration.
          </li>
          <li>
            <strong>CRM information:</strong> Customer names, phone numbers,
            contact details, tags, notes, pipeline and deal records, lead
            records (including Meta lead identifiers, names, phone numbers,
            email addresses, form names, campaign and advertisement
            attribution, assignment and stage data, and configured form
            answers), and other business information entered or imported by
            workspace users.
          </li>
          <li>
            <strong>Messaging information:</strong> WhatsApp conversations,
            message content, attachments, delivery status, and related
            metadata required to provide messaging features.
          </li>
          <li>
            <strong>Automation information:</strong> Workflow and flow
            definitions, node configurations, collected form responses,
            submission timestamps, run identifiers, and synchronization
            settings and field mappings configured for spreadsheet sync.
          </li>
          <li>
            <strong>Google integration information:</strong> Google account
            email addresses; spreadsheet identifiers, titles, URLs, and
            worksheet identifiers and titles; per-table spreadsheet, tab,
            column, and automatic-sync configuration; sync status, error
            messages, and row-mapping records used for delivery and retries;
            OAuth access tokens and refresh tokens; token expiry timestamps
            and granted scope records; and technical logs required to
            diagnose errors and maintain security. Each integration (Flow
            Tables and Meta Lead Ads → Google Sheets) has its own
            separately stored connection and configuration.
          </li>
          <li>
            <strong>Technical information:</strong> Security logs, error
            information, session data, and limited usage information necessary
            to operate and protect the Service.
          </li>
        </LegalList>
        <p>
          The information processed depends on the features enabled by the
          user and the permissions granted. Google data is accessed only when
          an authorized user connects a Google account and configures a
          spreadsheet sync.
        </p>
      </LegalSection>

      <LegalSection
        id="google-account-information"
        title="3. Google Account Information We Access"
      >
        <p>
          When you connect a Google account to {PRODUCT_NAME}, we access only
          the Google information required for the specific Google Sheets
          integration you choose to enable, and only within the permissions
          you authorize. The two integrations request different scopes:
        </p>
        <LegalList>
          <li>
            <strong>Flow Tables integration scopes:</strong>{" "}
            <code>
              https://www.googleapis.com/auth/drive.file
            </code>{" "}
            and{" "}
            <code>https://www.googleapis.com/auth/userinfo.email</code>.
          </li>
          <li>
            <strong>Meta Lead Ads → Google Sheets integration scopes:</strong>{" "}
            <code>
              https://www.googleapis.com/auth/spreadsheets
            </code>{" "}
            and{" "}
            <code>https://www.googleapis.com/auth/userinfo.email</code>.
          </li>
        </LegalList>
        <p>
          <strong>
            A. Flow Tables integration (CRM automation flows).
          </strong>{" "}
          This integration uses the non-sensitive <code>drive.file</code> and{" "}
          <code>userinfo.email</code> scopes only. It creates new
          spreadsheets on request and operates only on the linked
          application-created file. It does not enumerate, list, or discover
          every spreadsheet in the connected account, and the application
          does not call Drive file-listing APIs for this integration.
        </p>
        <p>For this integration we access:</p>
        <LegalList>
          <li>
            Your Google account email address, to identify the connected
            account and display which account is linked in the workspace.
          </li>
          <li>
            Google Drive files created by the application and made accessible
            to the application under the granted <code>drive.file</code>{" "}
            scope.
          </li>
          <li>
            Spreadsheet and worksheet identifiers, titles, URLs, and sheet
            structure for those application-created files, as needed to link
            a spreadsheet to a flow and configure column synchronization.
          </li>
          <li>
            Spreadsheet header and row data in the linked
            application-created file, but only as required to append
            automation responses, import explicitly requested past responses,
            update assigned cells, and manage headers and columns for the
            linked flow.
          </li>
          <li>
            OAuth access tokens and refresh tokens issued by Google for this
            integration, used only to call Google APIs for the linked files.
          </li>
        </LegalList>
        <p>
          <strong>
            B. Meta Lead Ads → Google Sheets integration.
          </strong>{" "}
          This separate integration uses the <code>spreadsheets</code> and{" "}
          <code>userinfo.email</code> scopes. It has its own OAuth callback,
          its own encrypted token storage, and its own per-table
          configuration, separate from the Flow Tables connection, so a
          grant for one integration cannot be used for the other.
        </p>
        <p>
          When an authorized user configures this integration, we access:
        </p>
        <LegalList>
          <li>
            The connected Google account email address, to identify which
            account is connected for Meta lead synchronization.
          </li>
          <li>
            The spreadsheet the authorized user identifies by pasting a
            Google Sheets URL or spreadsheet ID: we validate that the
            application can access it and read its spreadsheet identifier,
            title, URL, and worksheet tab names before saving it as the
            table&apos;s configured target.
          </li>
          <li>
            Spreadsheets created by the application at the user&apos;s
            request, including the initial worksheet and managed header row.
          </li>
          <li>
            The configured spreadsheet&apos;s worksheets, header row, column
            configuration, and row data as needed to append new Meta lead
            records, update existing rows matched by the stable lead
            identifier, manage tabs and headers, and perform explicitly
            requested imports, sync-now runs, backfills, and retries.
          </li>
          <li>
            OAuth access tokens and refresh tokens issued by Google for this
            integration, used only to call Google APIs for the configured
            spreadsheets.
          </li>
        </LegalList>
        <p>
          {PRODUCT_NAME} does not access Gmail, Google Calendar, Google
          Contacts, Google Photos, or Google Drive files beyond what is
          described above through either Google Sheets integration.
        </p>
      </LegalSection>

      <LegalSection
        id="how-sheets-data-used"
        title="4. How We Use Google Sheets Data"
      >
        <p>
          We use Google Sheets data exclusively to provide the spreadsheet
          synchronization features requested by authorized workspace users.
          All reading, writing, importing, and synchronizing is limited to
          the configured spreadsheets and to the functionality implemented by
          the application. Google data is never used for advertising, sale,
          credit decisions, or unrelated profiling or analytics.
        </p>
        <p>
          <strong>
            A. Flow Tables integration (CRM automation flows) — purposes.
          </strong>{" "}
          For the spreadsheets linked to automation flows, this integration:
        </p>
        <LegalList>
          <li>
            Creates a new spreadsheet when the authorized user requests it,
            and links that newly created spreadsheet to the flow (or replaces
            the currently linked spreadsheet with a newly created one).
          </li>
          <li>
            Reads the linked spreadsheet&apos;s worksheet structure and
            column headings to configure synchronization and to align future
            appends with the stored column order.
          </li>
          <li>
            Appends information collected when a contact reaches a Google
            Sheets sync node as a new row — including the configured phone
            number, submission time, flow-captured answers, traveller
            details, destination preferences, and other fields selected in
            the flow configuration.
          </li>
          <li>
            Imports previously completed automation responses into the linked
            spreadsheet when the authorized user explicitly requests a
            date-range import.
          </li>
          <li>
            Writes header cells and data cells as needed to extend columns,
            rename headers, enrich an already-synced row (for example,
            assignment updates located by the stored run identifier), and
            maintain the stored synchronization configuration.
          </li>
          <li>Unlinks a spreadsheet on request, which stops future syncing.</li>
        </LegalList>
        <p>
          <strong>
            B. Meta Lead Ads → Google Sheets integration — purposes.
          </strong>{" "}
          For the spreadsheets configured for Meta lead tables, this
          integration:
        </p>
        <LegalList>
          <li>
            Creates a new spreadsheet with a managed header row when the
            authorized user requests it.
          </li>
          <li>
            Validates a pasted spreadsheet URL or ID by reading its metadata
            (identifier, title, URL, worksheet names) and saves it as the
            table&apos;s configured target only after verifying access;
            reads and manages worksheet tabs and the header row required by
            the configured columns.
          </li>
          <li>
            Appends new Meta lead records as rows and updates existing rows
            matched by the stable Meta lead identifier, including automatic
            syncing of new leads when enabled and explicitly requested
            manual sync-now runs, historical imports, backfills, and retries.
          </li>
          <li>
            Applies the table&apos;s saved column selection, worksheet
            selection, and automatic-sync setting, and records sync status
            and errors so failures can be diagnosed and retried.
          </li>
        </LegalList>
        <p>
          <strong>What Google data is written to spreadsheets.</strong>{" "}
          Depending on configuration, rows may include phone numbers, names,
          email addresses, form answers, lead identifiers, form and campaign
          attribution, submission timestamps, assignment and stage data, and
          other fields the workspace user selects. No other Google data is
          written anywhere else.
        </p>
        <p>
          We do not use Google user data for advertising, selling personal
          information, creditworthiness assessments, lending decisions, or
          purposes unrelated to providing or improving the user-facing
          spreadsheet features described above.
        </p>
        <p>
          We do not use Google Workspace API data to train or improve
          generalized or non-personalized artificial intelligence or
          machine-learning models.
        </p>
      </LegalSection>

      <LegalSection
        id="data-storage"
        title="5. Storage of Google User Data"
      >
        <p>
          To operate the integrations, we store the minimum Google-related
          information necessary:
        </p>
        <LegalList>
          <li>
            The email address associated with each connected Google account,
            used to display which account is linked.
          </li>
          <li>
            OAuth access tokens and refresh tokens for each connected
            integration, each grant stored as its own per-account record.
            Tokens are encrypted with AES-256-GCM before storage and are
            never returned to the browser: status and configuration APIs
            expose only connection state and the account email, never token
            values. Stored tokens are looked up scoped to the workspace
            account, refreshed before expiry, and the refreshed values are
            re-encrypted and persisted.
          </li>
          <li>
            Spreadsheet identifiers, titles, URLs, worksheet identifiers and
            titles, and token expiry and granted-scope records.
          </li>
          <li>
            Synchronization settings and field mappings, including per-flow
            sheet links and answer-column configuration for Flow Tables, and
            per-table spreadsheet, tab, column, and automatic-sync
            configuration for Meta Lead Ads.
          </li>
          <li>
            Durable sync records used for reliable delivery: per-flow header
            and row alignment state for Flow Tables, and a per-submission
            sync queue with spreadsheet row mapping, attempt counts, and
            status and error records for Meta Lead Ads delivery and retries.
          </li>
          <li>
            Technical logs and sync status records needed to diagnose errors,
            prevent duplicates, and maintain security.
          </li>
        </LegalList>
        <p>
          Data is stored in our application database (Supabase) with
          account-scoped access controls so one workspace account&apos;s
          Google connection and sync records cannot be read or used by
          another account. Access to stored Google data is restricted to
          authorized personnel and automated processes that require it to
          operate, maintain, or secure the Service.
        </p>
        <p>
          CRM information may also be stored in the {PRODUCT_NAME} workspace
          independently of the Google Sheets integrations (for example, lead
          submissions that are queued for sync). When information is sent to
          a Google spreadsheet, that spreadsheet is maintained by Google
          under the connected account&apos;s control.
        </p>
        <p>
          We do not intentionally maintain a separate copy of an entire
          Google spreadsheet. The application stores identifiers,
          configuration, row-mapping references, and queued submission data
          needed for delivery — not a duplicate of the spreadsheet contents
          — unless retaining such data is necessary to perform an action the
          user requested (for example, completing a requested import or
          retry).
        </p>
      </LegalSection>

      <LegalSection
        id="third-party-sharing"
        title="6. How We Share Google User Data"
      >
        <p>We do not sell, rent, or trade Google user data.</p>
        <p>
          We disclose or transmit Google user data only to the following
          categories of recipients and only when necessary for the permitted
          purpose described:
        </p>
        <LegalList>
          <li>
            <strong>Google APIs, at your direction:</strong> when you enable
            a sync, the application calls Google Sheets (and, for token
            refresh, Google&apos;s OAuth token endpoint) to read or write
            only the configured spreadsheets for that integration. Each
            integration calls Google APIs only for its own configured
            spreadsheets using its own grant.
          </li>
          <li>
            <strong>Service providers (sub-processors):</strong> hosting,
            database, and infrastructure providers that store and process
            information to operate the Service on our behalf — including
            Supabase for application database and hosting infrastructure —
            under appropriate confidentiality and data-protection
            obligations. These providers do not receive direct Google API
            access; they store the encrypted records described in Section 5.
          </li>
          <li>
            <strong>User-authorized integrations:</strong> other services a
            workspace user explicitly connects (for example, WhatsApp for
            messaging delivery), as needed to perform the requested feature.
            Connecting one Google integration does not authorize data use by
            the other integration or by any other connected service.
          </li>
          <li>
            <strong>Legal and safety obligations:</strong> when disclosure is
            required by applicable law or valid legal process, or is
            necessary to protect the rights, safety, and security of users
            and the public.
          </li>
          <li>
            <strong>Business transfers:</strong> where permitted by applicable
            law and Google&apos;s policies, in connection with a merger,
            acquisition, or sale of assets, subject to applicable notice and
            consent requirements.
          </li>
        </LegalList>
        <p>
          We do not disclose Google user data to advertisers, data brokers,
          or any third party for advertising, data brokerage, unrelated
          profiling, creditworthiness or lending decisions, or any other
          purpose prohibited by Google&apos;s policies.
        </p>
      </LegalSection>

      <LegalSection
        id="google-api-services-user-data"
        title="7. Google API Services User Data Policy and Limited Use"
      >
        <p>
          {PRODUCT_NAME}&rsquo;s use and transfer of information received from
          Google APIs complies with the Google API Services User Data Policy,
          including its Limited Use requirements. These requirements apply
          equally to data from both the Flow Tables integration (using{" "}
          <code>drive.file</code>) and the Meta Lead Ads → Google Sheets
          integration (using <code>spreadsheets</code>).
        </p>
        <p>Specifically, for Google user data:</p>
        <LegalList>
          <li>
            We use Google data only to provide or improve the user-facing
            spreadsheet synchronization features described in Section 4,
            which are prominent and relevant in the Service.
          </li>
          <li>
            We do not sell Google user data, and we do not use or transfer
            Google user data for targeted, personalized, or interest-based
            advertising.
          </li>
          <li>
            We do not transfer Google user data to any other party except as
            necessary to provide or improve the requested spreadsheet
            features (Section 6), to comply with applicable law, or in other
            circumstances expressly permitted by Google&apos;s policies
            (such as a business transfer with required notice and consent).
          </li>
          <li>
            We do not use or transfer Google user data to determine
            creditworthiness or for lending purposes.
          </li>
          <li>
            We do not use Google Workspace API data to develop, improve, or
            train generalized or non-personalized artificial intelligence or
            machine-learning models.
          </li>
          <li>
            Human access to Google user data is restricted and permitted only
            with the user&apos;s affirmative agreement for the specific data
            concerned, where necessary for security or abuse investigations,
            to comply with applicable law, or as otherwise expressly
            permitted by Google&apos;s policies.
          </li>
        </LegalList>
        <p>
          Official policy:{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:text-primary/80"
          >
            https://developers.google.com/terms/api-services-user-data-policy
          </a>
        </p>
      </LegalSection>

      <LegalSection id="security" title="8. Security Measures">
        <p>
          We use administrative and technical safeguards designed to protect
          information against unauthorized access, alteration, disclosure, or
          destruction, including:
        </p>
        <LegalList>
          <li>Encrypted network connections (TLS) for data in transit.</li>
          <li>
            AES-256-GCM encryption of stored Google OAuth access and refresh
            tokens, with tokens never exposed to the browser and all stored
            token lookups scoped to the owning workspace account.
          </li>
          <li>
            Authentication, account-scoped authorization and row-level access
            controls, so one workspace cannot access another workspace&apos;s
            Google connection or sync records.
          </li>
          <li>
            Security monitoring, error logging limited to what is needed for
            diagnosis, and infrastructure maintenance.
          </li>
        </LegalList>
        <p>
          No method of transmission or storage is completely secure. We cannot
          guarantee absolute security, but we work to maintain appropriate
          safeguards for the Service. Please keep account credentials
          confidential and notify us promptly of suspected unauthorized
          access.
        </p>
      </LegalSection>

      <LegalSection id="data-retention" title="9. Data Retention">
        <p>
          We retain personal and business information for as long as
          reasonably necessary to provide the Service, maintain account
          functionality, satisfy legitimate operational requirements, comply
          with legal obligations, resolve disputes, and enforce agreements.
        </p>
        <p>
          Google integration credentials and related configuration for each
          integration are retained only while that integration remains
          connected and as needed to operate it. When you disconnect an
          integration or request account deletion, we delete or invalidate
          that integration&apos;s OAuth credentials and remove its related
          connection and configuration records in accordance with our
          deletion procedures and applicable retention requirements, except
          where retention is required by law.
        </p>
        <p>
          Disconnecting the Flow Tables connection stops future syncing; the
          per-flow sheet links are left intact but remain inactive until a
          Google account is reconnected. Disconnecting the Meta Lead Ads →
          Google Sheets connection removes that connection and disables
          automatic syncing; pending queued sync records may be retained so
          delivery can resume after a reconnect, but they are not processed
          while disconnected.
        </p>
        <p>
          Information already written to your Google spreadsheet remains in
          that spreadsheet, under your Google account&apos;s control, until
          you or an authorized person deletes it directly in Google Sheets.
          Deleting credentials in {PRODUCT_NAME} does not delete spreadsheet
          contents in Google.
        </p>
      </LegalSection>

      <LegalSection
        id="disconnect-google"
        title="10. Disconnecting Google and Revoking Access"
      >
        <p>
          You may disconnect a Google Sheets integration at any time through
          the relevant {PRODUCT_NAME} integration or flow settings (flow
          settings for the Flow Tables integration, or Meta settings for the
          Meta Lead Ads → Google Sheets connection). Disconnecting one
          integration stops only that integration and does not affect the
          other integration&apos;s connection.
        </p>
        <p>
          After disconnection, we immediately stop making new Google API
          requests for that integration and delete or invalidate its
          associated OAuth credentials in accordance with our procedures.
          Flow Tables sheet links are left intact but stop syncing until a
          Google account is reconnected; Meta automatic sync is disabled and
          existing spreadsheet contents are left untouched.
        </p>
        <p>
          You may also revoke {PRODUCT_NAME}&apos;s access at any time —
          independently of in-app disconnection — through your Google Account
          permissions page, which stops all future API calls using that
          grant:
        </p>
        <p>
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:text-primary/80"
          >
            https://myaccount.google.com/permissions
          </a>
        </p>
        <p>
          Disconnecting or revoking access does not automatically delete
          information previously written to a Google spreadsheet. You can
          manage or delete that information directly in Google Sheets.
        </p>
      </LegalSection>

      <LegalSection
        id="data-deletion"
        title="11. Requesting Data Deletion"
      >
        <p>
          To request deletion of your {PRODUCT_NAME} account or associated
          information — including stored Google integration credentials,
          Google-related configuration and sync records for either or both
          integrations — contact:
        </p>
        <p>
          <strong>Email:</strong>{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-primary hover:text-primary/80"
          >
            {SUPPORT_EMAIL}
          </a>
        </p>
        <p>
          Please identify your workspace account and describe the information
          you want deleted (for example, the connected Google account email
          and which integration the request concerns). We may request
          reasonable information to verify your identity and your authority
          to make the request.
        </p>
        <p>
          After verifying the request, we delete or anonymize the relevant
          information — including the applicable OAuth credentials,
          connection records, sync configurations, and queued sync records —
          subject to applicable legal obligations and legitimate retention
          requirements (for example, records we must retain for security,
          compliance, or dispute resolution).
        </p>
        <p>
          Data already written to a Google spreadsheet must generally be
          deleted directly from that spreadsheet by the account holder or an
          authorized user, because {PRODUCT_NAME} cannot delete your Google
          Drive contents after its access has been removed.
        </p>
      </LegalSection>

      <LegalSection
        id="cookies-analytics"
        title="12. Cookies and Technical Information"
      >
        <p>
          {PRODUCT_NAME} may use cookies and similar technologies necessary
          for authentication, session management, security, and core
          application functionality.
        </p>
        <p>
          Where analytics technologies are used, they are intended to help us
          understand Service performance and improve the product. Google user
          data is not used for advertising or unrelated analytics.
        </p>
      </LegalSection>

      <LegalSection
        id="third-party-services"
        title="13. Third-Party Services"
      >
        <p>
          {PRODUCT_NAME} may connect to third-party services, including Google
          and WhatsApp, when you enable the relevant functionality.
        </p>
        <p>
          Those services process information according to their own applicable
          terms and privacy policies. You should review the relevant
          third-party policies when connecting an integration.
        </p>
        <p>
          Our use of Google APIs remains subject to Google&apos;s applicable
          API terms and data policies, including the Google API Services User
          Data Policy referenced in Section 7.
        </p>
      </LegalSection>

      <LegalSection id="children" title="14. Children's Privacy">
        <p>
          {PRODUCT_NAME} is a business-oriented service and is not intended
          for children to use independently. We do not knowingly collect
          children&apos;s personal information in violation of applicable law.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="15. Changes to This Privacy Policy">
        <p>
          We may update this policy when our services, data practices, or
          legal obligations change.
        </p>
        <p>
          When material changes are made, we will update the effective date
          and provide additional notice where appropriate. Where required, we
          will obtain renewed consent before using Google user data for a new
          purpose.
        </p>
        <p>
          The current version will remain available at:
        </p>
        <p>
          <a
            href={`${WEBSITE_DOMAIN}/privacy-policy`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:text-primary/80"
          >
            {WEBSITE_DOMAIN}/privacy-policy
          </a>
        </p>
      </LegalSection>

      <LegalSection id="contact" title="16. Contact Us">
        <p>
          For questions, concerns, or requests relating to privacy, Google user
          data, or deletion, contact:
        </p>
        <p>
          <strong>{COMPANY_NAME}</strong>
          <br />
          <strong>Email:</strong>{" "}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="text-primary hover:text-primary/80"
          >
            {SUPPORT_EMAIL}
          </a>
          <br />
          <strong>Website:</strong>{" "}
          <a
            href={WEBSITE_DOMAIN}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:text-primary/80"
          >
            {WEBSITE_DOMAIN}
          </a>
        </p>
        <p>
          {PRODUCT_NAME} is operated by {COMPANY_NAME}.
        </p>
      </LegalSection>
    </article>
  );
}
