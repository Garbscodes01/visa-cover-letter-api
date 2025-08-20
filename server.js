/*
 * Visa Letter API
 *
 * This Express server exposes a single POST endpoint, /generate-letter, which
 * accepts applicant and travel information and uses the OpenAI API to
 * generate a well‑structured visa application cover letter. The letter is
 * formatted according to standard consular expectations and includes
 * information about the applicant’s identity, purpose of travel, funding
 * sources, accommodation, supporting documents and assurances of return.
 *
 * To run the server locally:
 *   1. Install dependencies with `npm install` inside the backend folder.
 *   2. Copy `.env.example` to `.env` and set your OpenAI API key.
 *   3. Start the server with `npm start`.
 */

// Lightweight .env loader: read key=value pairs from a .env file and assign to process.env.
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    if (!line || line.trim().startsWith('#')) return;
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) return;
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  });
}

// Load environment variables from .env if present
loadEnv();
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

// Validate presence of required environment variables early.
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY in .env');
  console.error('Please copy .env.example to .env and set your OpenAI API key.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5000;

// Configure middleware
//
// CORS configuration: allow all origins for development.
// When serving the frontend from a file:// URL, the Origin header is null, so using
// { origin: '*' } ensures that the `Access-Control-Allow-Origin: *` header is always
// present. In production you can restrict this to a specific domain.
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '1mb' })); // Parse JSON bodies up to 1MB.

// Initialize OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Simple health check endpoint
app.get('/', (_req, res) => {
  res.send('✅ Visa Letter API is running');
});

/**
 * Helper: clean strings. Convert empty strings to undefined so we can
 * conditionally omit fields when constructing the prompt. Trim
 * whitespace from non‑empty strings.
 *
 * @param {any} value
 * @returns {string|undefined}
 */
function clean(value) {
  if (value === undefined || value === null) return undefined;
  const str = String(value).trim();
  return str.length > 0 ? str : undefined;
}

/**
 * POST /generate-letter
 *
 * Accepts a JSON body containing applicant and travel information, builds
 * a detailed prompt using that data, and calls the OpenAI API to
 * generate a visa cover letter. Returns the generated letter as plain
 * text. Required fields are validated and missing fields are reported
 * back to the client with a 400 status.
 */
app.post('/generate-letter', async (req, res) => {
  try {
    // Destructure and sanitize input fields
    const {
      // Personal details
      name,
      age,
      nationality,
      applicantAddress,
      contactPhone,
      contactEmail,
      dateOfBirth,
      passportNumber,
      passportIssueDate,
      passportExpiryDate,
      maritalStatus,
      numDependents,
      // Travel & plans
      destination,
      visaType,
      purpose,
      travelDates,
      entryDate,
      stayDuration,
      invited,
      inviterName,
      inviterAddress,
      inviterRelationship,
      inviterDocs,
      stayDetails,
      travelItinerary,
      // Employment & finances
      occupation,
      employerName,
      employerAddress,
      employmentDuration,
      income,
      otherIncome,
      funding,
      bankStatementDetails,
      significantTransactions,
      // Ties to home country
      propertyDetails,
      businessCommitments,
      familyDependents,
      otherCommitments,
      // Travel & visa history
      travelHistory,
      visaRefusals,
      validVisas,
      // Sponsor information
      sponsorSelf,
      sponsorName,
      sponsorRelationship,
      sponsorOccupation,
      sponsorIncome,
      sponsorAccommodation,
      sponsorDocs,
      // Additional information
      specialEvents,
      compellingReasons,
      supportingLetters,
      potentialWeaknesses,
      // Existing fields
      accommodation,
      documents,
      embassyName,
      embassyAddress,
      companyName,
    } = req.body;

    const payload = {
      // Personal details
      name: clean(name),
      age: clean(age),
      nationality: clean(nationality),
      applicantAddress: clean(applicantAddress),
      contactPhone: clean(contactPhone),
      contactEmail: clean(contactEmail),
      dateOfBirth: clean(dateOfBirth),
      passportNumber: clean(passportNumber),
      passportIssueDate: clean(passportIssueDate),
      passportExpiryDate: clean(passportExpiryDate),
      maritalStatus: clean(maritalStatus),
      numDependents: clean(numDependents),
      // Travel & plans
      destination: clean(destination),
      visaType: clean(visaType),
      purpose: clean(purpose),
      travelDates: clean(travelDates),
      entryDate: clean(entryDate),
      stayDuration: clean(stayDuration),
      invited: clean(invited),
      inviterName: clean(inviterName),
      inviterAddress: clean(inviterAddress),
      inviterRelationship: clean(inviterRelationship),
      inviterDocs: clean(inviterDocs),
      stayDetails: clean(stayDetails),
      travelItinerary: clean(travelItinerary),
      // Employment & finances
      occupation: clean(occupation),
      employerName: clean(employerName),
      employerAddress: clean(employerAddress),
      employmentDuration: clean(employmentDuration),
      income: clean(income),
      otherIncome: clean(otherIncome),
      funding: clean(funding),
      bankStatementDetails: clean(bankStatementDetails),
      significantTransactions: clean(significantTransactions),
      // Ties to home country
      propertyDetails: clean(propertyDetails),
      businessCommitments: clean(businessCommitments),
      familyDependents: clean(familyDependents),
      otherCommitments: clean(otherCommitments),
      // Travel & visa history
      travelHistory: clean(travelHistory),
      visaRefusals: clean(visaRefusals),
      validVisas: clean(validVisas),
      // Sponsor information
      sponsorSelf: clean(sponsorSelf),
      sponsorName: clean(sponsorName),
      sponsorRelationship: clean(sponsorRelationship),
      sponsorOccupation: clean(sponsorOccupation),
      sponsorIncome: clean(sponsorIncome),
      sponsorAccommodation: clean(sponsorAccommodation),
      sponsorDocs: clean(sponsorDocs),
      // Additional information
      specialEvents: clean(specialEvents),
      compellingReasons: clean(compellingReasons),
      supportingLetters: clean(supportingLetters),
      potentialWeaknesses: clean(potentialWeaknesses),
      // Existing
      accommodation: clean(accommodation),
      documents: clean(documents),
      embassyName: clean(embassyName),
      embassyAddress: clean(embassyAddress),
      companyName: clean(companyName) || 'No Guide Travel Agent',
    };

    // Required fields for generating a meaningful letter
    const requiredFields = ['name', 'age', 'nationality', 'destination', 'visaType', 'purpose', 'income'];
    const missing = requiredFields.filter((key) => !payload[key]);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    // Construct a detailed description of the applicant and trip in a structured block.
    const details = [];
    // Identity & personal information
    details.push(`Full Name: ${payload.name}`);
    details.push(`Age: ${payload.age}`);
    details.push(`Nationality: ${payload.nationality}`);
    if (payload.dateOfBirth) details.push(`Date of Birth: ${payload.dateOfBirth}`);
    if (payload.passportNumber) details.push(`Passport Number: ${payload.passportNumber}`);
    if (payload.passportIssueDate) details.push(`Passport Issue Date: ${payload.passportIssueDate}`);
    if (payload.passportExpiryDate) details.push(`Passport Expiry Date: ${payload.passportExpiryDate}`);
    if (payload.maritalStatus) details.push(`Marital Status: ${payload.maritalStatus}`);
    if (payload.numDependents) details.push(`Number of Dependents: ${payload.numDependents}`);
    if (payload.applicantAddress) details.push(`Address: ${payload.applicantAddress}`);
    if (payload.contactPhone) details.push(`Phone: ${payload.contactPhone}`);
    if (payload.contactEmail) details.push(`Email: ${payload.contactEmail}`);
    // Travel details
    details.push(`Destination: ${payload.destination}`);
    details.push(`Visa Type: ${payload.visaType}`);
    if (payload.travelDates) details.push(`Travel Dates: ${payload.travelDates}`);
    if (payload.entryDate) details.push(`Entry Date: ${payload.entryDate}`);
    if (payload.stayDuration) details.push(`Duration of Stay: ${payload.stayDuration}`);
    details.push(`Purpose of Travel: ${payload.purpose}`);
    if (payload.invited) details.push(`Invited by someone in UK?: ${payload.invited}`);
    if (payload.inviterName) details.push(`Inviter Name: ${payload.inviterName}`);
    if (payload.inviterAddress) details.push(`Inviter Address: ${payload.inviterAddress}`);
    if (payload.inviterRelationship) details.push(`Inviter Relationship: ${payload.inviterRelationship}`);
    if (payload.inviterDocs) details.push(`Inviter Documents: ${payload.inviterDocs}`);
    if (payload.stayDetails) details.push(`Stay Details: ${payload.stayDetails}`);
    if (payload.travelItinerary) details.push(`Travel Itinerary: ${payload.travelItinerary}`);
    // Employment & finances
    if (payload.occupation) details.push(`Occupation: ${payload.occupation}`);
    if (payload.employerName) details.push(`Employer/Business Name: ${payload.employerName}`);
    if (payload.employerAddress) details.push(`Employer/Business Address: ${payload.employerAddress}`);
    if (payload.employmentDuration) details.push(`Employment Duration: ${payload.employmentDuration}`);
    details.push(`Monthly Income: ${payload.income}`);
    if (payload.otherIncome) details.push(`Other Income: ${payload.otherIncome}`);
    details.push(`Funding Source: ${payload.funding || 'Self-funded'}`);
    if (payload.bankStatementDetails) details.push(`Bank Statement Details: ${payload.bankStatementDetails}`);
    if (payload.significantTransactions) details.push(`Significant Transactions: ${payload.significantTransactions}`);
    // Logistics
    if (payload.accommodation) details.push(`Accommodation: ${payload.accommodation}`);
    if (payload.documents) details.push(`Supporting Documents: ${payload.documents}`);
    // Ties to home country
    if (payload.propertyDetails) details.push(`Property Details: ${payload.propertyDetails}`);
    if (payload.businessCommitments) details.push(`Business/Employment Commitments: ${payload.businessCommitments}`);
    if (payload.familyDependents) details.push(`Family/Dependents: ${payload.familyDependents}`);
    if (payload.otherCommitments) details.push(`Other Commitments: ${payload.otherCommitments}`);
    // Travel & visa history
    if (payload.travelHistory) details.push(`Travel History: ${payload.travelHistory}`);
    if (payload.visaRefusals) details.push(`Visa Refusals: ${payload.visaRefusals}`);
    if (payload.validVisas) details.push(`Valid Visas: ${payload.validVisas}`);
    // Sponsor information
    if (payload.sponsorSelf) details.push(`Self-sponsored: ${payload.sponsorSelf}`);
    if (payload.sponsorName) details.push(`Sponsor Name: ${payload.sponsorName}`);
    if (payload.sponsorRelationship) details.push(`Sponsor Relationship: ${payload.sponsorRelationship}`);
    if (payload.sponsorOccupation) details.push(`Sponsor Occupation: ${payload.sponsorOccupation}`);
    if (payload.sponsorIncome) details.push(`Sponsor Income: ${payload.sponsorIncome}`);
    if (payload.sponsorAccommodation) details.push(`Sponsor Accommodation Provided?: ${payload.sponsorAccommodation}`);
    if (payload.sponsorDocs) details.push(`Sponsor Documents: ${payload.sponsorDocs}`);
    // Additional information
    if (payload.specialEvents) details.push(`Special Events: ${payload.specialEvents}`);
    if (payload.compellingReasons) details.push(`Compelling Reasons: ${payload.compellingReasons}`);
    if (payload.supportingLetters) details.push(`Supporting Letters/Docs: ${payload.supportingLetters}`);
    if (payload.potentialWeaknesses) details.push(`Potential Weaknesses: ${payload.potentialWeaknesses}`);
    // Consular & company info
    details.push(`Company: ${payload.companyName}`);
    if (payload.embassyName) details.push(`Embassy Name: ${payload.embassyName}`);
    if (payload.embassyAddress) details.push(`Embassy Address: ${payload.embassyAddress}`);

    // Build the prompt for the model. Provide a system message to instruct the
    // assistant to behave like an expert consular assistant; supply a
    // format guide to ensure the letter is structured consistently; and
    // include the user details block followed by an instruction to generate
    // the cover letter. The prompt emphasises that the output should be
    // plain text only.
    const systemMessage = {
      role: 'system',
      content:
        'You are an expert consular assistant. You write professional and embassy‑acceptable visa application cover letters. Always use a formal, polite and concise tone and avoid slang or casual language. Do not include any AI disclosures or placeholder text. When drafting the letter, follow these style guidelines: begin with a clear heading stating the type of visa application and purpose; address any potential issues proactively (such as unusual bank transactions, self‑employment income or previous refusals) by providing clarifications and references to supporting documents; organise the body into coherent paragraphs covering personal identity (name, date of birth, nationality), travel purpose and dates, employment and income details, financial sources and transactions, accommodation and invitation arrangements, and ties to the home country; list attached documents succinctly when appropriate; emphasise strong reasons to return home (family, property, business commitments, investments) and acknowledge awareness of immigration rules; conclude politely with an assurance of compliance and the applicant’s full name.',
    };

    const formatGuide = {
      role: 'user',
      content: `Please follow this structure when writing the visa cover letter:\n\n1. Applicant contact block: full name, address if provided, phone/email if provided, and the current date.\n2. Embassy block: if embassy name and address are provided, include them; otherwise omit.\n3. Subject line: 'Application for [Visa Type] to [Destination]'.\n4. Salutation: 'Dear Sir/Madam,'.\n5. Body paragraphs in this order: identity (name, nationality, purpose, travel dates); employment and income details; funding and accommodation arrangements; list of supporting documents as a brief bullet list; assurance of strong ties to home country and return.\n6. Closing: 'Sincerely,' followed by the applicant's full name.\n\nUse short paragraphs, avoid slang, and return plain text only.`,
    };

    const userInstruction = {
      role: 'user',
      content: `Generate a visa application cover letter using the following details:\n\n${details.map((line) => '- ' + line).join('\n')}\n\nMake sure the letter is embassy‑acceptable and only include provided information. Do not invent any details.`,
    };

    // Make the API request to OpenAI
    const completion = await openai.chat.completions.create({
      // Use GPT‑5 mini to generate the letter. GPT‑5 mini is a faster, cost‑efficient
      // version of GPT‑5, suitable for well‑defined tasks. It’s available on the
      // Chat Completions API and priced lower per token than GPT‑5【815236350890910†L523-L530】.
      model: 'gpt-5-mini',
      temperature: 0.2,
      max_tokens: 800,
      messages: [systemMessage, formatGuide, userInstruction],
    });

    const letter = completion.choices?.[0]?.message?.content?.trim();
    if (!letter) {
      return res.status(502).json({ error: 'The AI returned no content.' });
    }

    // Success: return the generated letter
    res.json({ letter });
  } catch (err) {
    // Log the error details for debugging but return a generic error to clients.
    console.error('Error generating letter:', err);
    if (err?.response?.data) {
      console.error('OpenAI API response:', err.response.data);
    }
    res.status(500).json({ error: 'Failed to generate letter' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`✅ Visa Letter API listening on http://localhost:${PORT}`);
});