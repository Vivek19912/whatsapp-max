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
          This Privacy Policy explains what information we collect, how we
          access and use Google user data, how information is stored and
          shared, and how users can exercise their privacy rights.
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
          Depending on how you use {PRODUCT_NAME}, we may process the following
          categories of information:
        </p>
        <LegalList>
          <li>
            <strong>Account information:</strong> Name, email address,
            authentication credentials, organisation name, team membership, and
            account settings.
          </li>
          <li>
            <strong>CRM information:</strong> Customer names, phone numbers,
            contact details, tags, notes, lead records, and other business
            information entered or imported by workspace users.
          </li>
          <li>
            <strong>Messaging information:</strong> WhatsApp conversations,
            message content, attachments, delivery status, and related metadata
            required to provide messaging features.
          </li>
          <li>
            <strong>Automation information:</strong> Workflow configurations,
            form responses, submission timestamps, and information collected
            through configured automation flows.
          </li>
          <li>
            <strong>Google integration information:</strong> Google account
            email addresses, spreadsheet identifiers, sheet identifiers,
            integration settings, OAuth access tokens, refresh tokens, and
            technical information required to operate the Google Sheets
            integrations. Each integration (Flow Tables and Meta Lead Ads →
            Google Sheets) has its own separately stored connection.
          </li>
          <li>
            <strong>Technical information:</strong> Security logs, error
            information, session data, and limited usage information necessary
            to operate and protect the Service.
          </li>
        </LegalList>
        <p>
          The information processed depends on the features enabled by the user
          and the permissions granted.
        </p>
      </LegalSection>

      <LegalSection
        id="google-account-information"
        title="3. Google Account Information We Access"
      >
        <p>
          When you connect a Google account to {PRODUCT_NAME}, we access only
          the Google information required for the Google Sheets integration
          you choose to enable, and only within the permissions you authorize.
          {PRODUCT_NAME} provides two separate Google Sheets integrations,
          each with its own OAuth grant and stored connection:
        </p>
        <p>
          <strong>
            A. Flow Tables integration (CRM automation flows).
          </strong>{" "}
          This integration uses the non-sensitive OAuth scopes{" "}
          <code>drive.file</code> and <code>userinfo.email</code> only.
        </p>
        <p>This may include:</p>
        <LegalList>
          <li>
            Your Google account email address to identify the connected
            account.
          </li>
          <li>
            Google Drive files created by the application and made accessible
            to the application under the granted <code>drive.file</code>{" "}
            scope. We do not enumerate, list, or discover every spreadsheet
            in the connected account.
          </li>
          <li>
            Spreadsheet and worksheet identifiers, titles, URLs, and structure
            for those application-created files, as needed to configure
            synchronization.
          </li>
          <li>
            Spreadsheet data in a linked application-created file, but only as
            required to perform an action you explicitly request.
          </li>
          <li>
            Authorization credentials issued by Google that allow the
            integration to operate.
          </li>
        </LegalList>
        <p>
          The Flow Tables integration creates new spreadsheets on request and
          operates only on the linked application-created file. The
          application does not call Drive file-listing APIs.
        </p>
        <p>
          <strong>
            B. Meta Lead Ads → Google Sheets integration.
          </strong>{" "}
          This separate integration uses the OAuth scopes{" "}
          <code>spreadsheets</code> and <code>userinfo.email</code>. It uses
          its own connection, callback, and encrypted token storage, separate
          from the Flow Tables connection, so a grant for one integration
          cannot be used for the other.
        </p>
        <p>
          When an authorized user configures this integration, it may access:
        </p>
        <LegalList>
          <li>
            The connected Google account email address to identify the
            connection.
          </li>
          <li>
            A spreadsheet the authorized user identifies by pasting a Google
            Sheets URL or spreadsheet ID, solely to validate that the
            application can access it and to read its title, URL, and
            worksheet tab names before saving the configuration.
          </li>
          <li>
            Spreadsheets created by the application at the user&apos;s request,
            including the initial worksheet and header.
          </li>
          <li>
            The linked spreadsheet&apos;s worksheets, header row, and row data
            as needed to write new leads, update existing rows, manage the
            configured columns and tabs, and perform explicitly requested
            imports or retries.
          </li>
          <li>
            Authorization credentials (OAuth access and refresh tokens) issued
            by Google for this integration.
          </li>
        </LegalList>
        <p>
          {PRODUCT_NAME} does not access Gmail, Google Calendar, Google Photos,
          or Google Contacts through either Google Sheets integration.
        </p>
      </LegalSection>

      <LegalSection
        id="how-sheets-data-used"
        title="4. How We Use Google Sheets Data"
      >
        <p>
          We use Google Sheets data exclusively to provide the Google Sheets
          integration features requested by authorized workspace users. All
          reading, writing, importing, and synchronizing is limited to
          authorized files and to the functionality actually implemented by
          the application.
        </p>
        <p>
          <strong>
            A. Flow Tables integration (CRM automation flows).
          </strong>{" "}
          Depending on the granted permissions and the actions selected, this
          integration may:
        </p>
        <LegalList>
          <li>Create a spreadsheet when the user requests this feature.</li>
          <li>
            Link a newly created spreadsheet to a flow, or replace the
            currently linked spreadsheet with a newly created one. The
            application does not list or discover every spreadsheet in the
            connected Google account.
          </li>
          <li>
            Read the linked spreadsheet&apos;s structure or column headings to
            configure synchronization.
          </li>
          <li>
            Append information collected through configured CRM automation
            flows to the linked spreadsheet.
          </li>
          <li>
            Import previously collected automation responses into the linked
            spreadsheet when the user explicitly requests an import.
          </li>
          <li>
            Maintain the configuration needed to keep the selected integration
            operational.
          </li>
        </LegalList>
        <p>
          <strong>
            B. Meta Lead Ads → Google Sheets integration.
          </strong>{" "}
          This integration synchronizes Meta lead records to a configured
          spreadsheet. Based on the implemented functionality, it may:
        </p>
        <LegalList>
          <li>
            Create a new spreadsheet with a managed header at the
            user&apos;s request.
          </li>
          <li>
            Validate a pasted spreadsheet URL or ID, read its title and
            worksheet names, and save it as the table&apos;s configured target
            after verifying access.
          </li>
          <li>
            Create, identify, or manage worksheet tabs and the header row
            needed for the configured columns.
          </li>
          <li>
            Append new Meta lead records as rows and update existing rows
            (matched by the stable lead identifier), including explicitly
            requested backfills, imports, sync-now runs, and retries.
          </li>
          <li>
            Store and apply the table&apos;s configured columns, worksheet
            selection, and automatic-sync setting.
          </li>
        </LegalList>
        <p>
          Information written to a spreadsheet may include phone numbers, form
          answers, lead details, timestamps, destination preferences, and other
          fields selected or configured by the workspace user.
        </p>
        <p>
          We do not use Google user data for advertising, selling personal
          information, creditworthiness assessments, lending decisions, or
          purposes unrelated to providing or improving user-facing features of{" "}
          {PRODUCT_NAME}.
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
        <p>To operate the integrations, we may store:</p>
        <LegalList>
          <li>The email address associated with each connected Google account.</li>
          <li>
            OAuth access tokens and refresh tokens for each connected
            integration. Each integration has its own separately stored grant.
          </li>
          <li>Spreadsheet and worksheet identifiers.</li>
          <li>Synchronization settings and field mappings.</li>
          <li>
            Technical logs needed to diagnose errors and maintain security.
          </li>
        </LegalList>
        <p>
          For the Meta Lead Ads → Google Sheets integration, this includes a
          separate encrypted connection record, per-table spreadsheet, tab,
          column, and automatic-sync configuration, and a durable sync queue
          that maps lead submissions to spreadsheet rows for delivery and
          retries.
        </p>
        <p>
          OAuth credentials are stored using the security controls implemented
          by our application. Where encryption at rest is implemented,
          sensitive credentials are encrypted. We restrict access to
          information to authorized personnel and processes that require it to
          operate, maintain, or secure the Service.
        </p>
        <p>
          CRM information may also be stored in the {PRODUCT_NAME} workspace
          independently of the Google Sheets integration. When information is
          sent to a Google spreadsheet, the spreadsheet is maintained by Google
          under the connected account&apos;s control.
        </p>
        <p>
          We do not intentionally maintain a separate copy of an entire Google
          spreadsheet unless it is necessary to perform a user-requested
          operation.
        </p>
      </LegalSection>

      <LegalSection
        id="third-party-sharing"
        title="6. How We Share Google User Data"
      >
        <p>We do not sell, rent, or trade Google user data.</p>
        <p>
          We may transfer or disclose information only when necessary for
          permitted purposes, including:
        </p>
        <LegalList>
          <li>
            <strong>Service providers:</strong> Hosting, database, security,
            and other infrastructure providers that process information to
            operate the Service on our behalf.
          </li>
          <li>
            <strong>User-authorized integrations:</strong> Google and other
            services that a user chooses to connect, as needed to perform the
            requested functionality.
          </li>
          <li>
            <strong>Legal obligations:</strong> When disclosure is required by
            applicable law, a valid legal process, or necessary to protect the
            rights and security of users and the public.
          </li>
          <li>
            <strong>Business transfers:</strong> Where permitted by applicable
            law and Google&apos;s policies, in connection with a merger,
            acquisition, or sale of assets, subject to applicable notice and
            consent requirements.
          </li>
        </LegalList>
        <p>
          We do not disclose Google user data to third parties for
          advertising, data brokerage, unrelated profiling, or other purposes
          prohibited by Google&apos;s policies. Each integration transmits
          data only to Google APIs for its own configured spreadsheets.
        </p>
      </LegalSection>

      <LegalSection
        id="google-api-services-user-data"
        title="7. Google API Services User Data Policy and Limited Use"
      >
        <p>
          {PRODUCT_NAME}&rsquo;s use and transfer of information received from
          Google APIs complies with the Google API Services User Data Policy,
          including its Limited Use requirements. These requirements apply to
          data from both the Flow Tables integration and the Meta Lead Ads →
          Google Sheets integration.
        </p>
        <p>Specifically:</p>
        <LegalList>
          <li>
            We use Google data only to provide or improve user-facing features
            that are visible and relevant to the Service.
          </li>
          <li>
            We do not sell Google user data or use it for targeted,
            personalized, or interest-based advertising.
          </li>
          <li>
            We do not transfer Google user data except as necessary to provide
            or improve the requested features, as permitted by applicable law,
            or in other circumstances expressly permitted by Google&apos;s
            policies.
          </li>
          <li>
            We do not use Google user data for creditworthiness assessments or
            lending purposes.
          </li>
          <li>
            We do not use Google Workspace API data to develop, improve, or
            train generalized or non-personalized AI or machine-learning
            models.
          </li>
          <li>
            Human access to Google user data is restricted and permitted only
            where authorized by the user, necessary for security or abuse
            investigations, required by law, or otherwise permitted by
            Google&apos;s policies.
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
          destruction.
        </p>
        <p>
          Depending on the relevant system and data, these safeguards may
          include encrypted network connections, protection of stored
          credentials, authentication controls, access restrictions, security
          monitoring, and infrastructure maintenance.
        </p>
        <p>
          No method of transmission or storage is completely secure. We cannot
          guarantee absolute security, but we work to maintain appropriate
          safeguards for the Service.
        </p>
      </LegalSection>

      <LegalSection id="data-retention" title="9. Data Retention">
        <p>
          We retain information for as long as reasonably necessary to provide
          the Service, maintain account functionality, satisfy legitimate
          operational requirements, comply with legal obligations, resolve
          disputes, and enforce agreements.
        </p>
        <p>
          Google integration credentials and related configuration for each
          integration are retained only as necessary to operate that
          integration. When a user disconnects an integration or requests
          account deletion, we delete or invalidate the associated
          credentials for that integration and remove related information in
          accordance with our deletion procedures and applicable retention
          requirements.
        </p>
        <p>
          Disconnecting the Meta Lead Ads → Google Sheets connection removes
          that connection and disables automatic syncing; queued sync records
          may be retained so delivery can resume after a reconnect, but they
          are not processed while disconnected.
        </p>
        <p>
          Information already written to a user&apos;s Google spreadsheet
          remains in that spreadsheet until the user or an authorized person
          deletes it.
        </p>
      </LegalSection>

      <LegalSection
        id="disconnect-google"
        title="10. Disconnecting Google and Revoking Access"
      >
        <p>
          Users may disconnect a Google Sheets integration through the
          relevant {PRODUCT_NAME} integration or flow settings (flow settings
          for the Flow Tables integration, or Meta settings for the Meta Lead
          Ads → Google Sheets connection). Disconnecting one integration does
          not affect the other integration&apos;s connection.
        </p>
        <p>
          After disconnection, we stop making new Google API requests for that
          integration and delete or invalidate the associated OAuth credentials
          for that integration in accordance with our procedures. Flow Tables
          sheet links are left intact but stop syncing until a Google account
          is reconnected; Meta automatic sync is disabled and existing
          spreadsheet contents are left untouched.
        </p>
        <p>
          Users can also review and revoke application access through their
          Google Account permissions page:
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
          Disconnecting the integration does not automatically delete
          information previously written to a Google spreadsheet. Users can
          manage that information directly in Google Sheets.
        </p>
      </LegalSection>

      <LegalSection
        id="data-deletion"
        title="11. Requesting Data Deletion"
      >
        <p>
          To request deletion of your {PRODUCT_NAME} account or associated
          information, contact:
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
          Please identify your account and describe the information you want
          deleted. We may request reasonable information to verify your
          identity and authority to make the request.
        </p>
        <p>
          After verifying the request, we will delete or anonymize the relevant
          information, including stored Google integration credentials and
          Google-related information for each connected integration, subject
          to applicable legal obligations and legitimate retention
          requirements.
        </p>
        <p>
          Data already written to a Google spreadsheet must generally be
          deleted directly from that spreadsheet by the account holder or an
          authorized user.
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
          and WhatsApp, when users enable the relevant functionality.
        </p>
        <p>
          Those services process information according to their own applicable
          terms and privacy policies. Users should review the relevant
          third-party policies when connecting an integration.
        </p>
        <p>
          Our use of Google APIs remains subject to Google&apos;s applicable
          API terms and data policies.
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
