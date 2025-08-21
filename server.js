/**
 * Visa Letter API — Render-ready
 * - CORS allow-list for your Static Site (via FRONTEND_ORIGIN)
 * - Works with gpt-5-mini (no temperature/max_tokens); graceful fallback
 * - Clear errors for debugging
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { OpenAI } = require('openai');

// ------------------------ Load .env for local dev ------------------------
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    if (!line || line.trim().startsWith('#')) return;
    const i = line.indexOf('=');
    if (i === -1) return;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  });
}
loadEnv();

// ------------------------ Required env ------------------------
if (!process.env.OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

const MODEL_NAME = process.env.MODEL_NAME || 'gpt-5-mini';
const FALLBACK_MODEL = process.env.FALLBACK_MODEL || 'gpt-4o-mini';
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || ''; // e.g. https://visa-cover-letter-api-1.onrender.com

// ------------------------ App & Middleware ------------------------
const app = express();
const PORT = process.env.PORT || 5000;

// CORS: allow your Static Site + localhost dev; otherwise allow all (dev)
if (FRONTEND_ORIGIN) {
  const allowedOrigins = new Set([
    FRONTEND_ORIGIN,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]);
  app.use(
    cors({
      origin(origin, cb) {
        if (!origin) return cb(null, true); // Postman/curl
        if (allowedOrigins.has(origin)) return cb(null, true);
        return cb(new Error(`CORS blocked: ${origin}`));
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );
  app.options('*', cors());
} else {
  // Permissive for local/dev; lock down later by setting FRONTEND_ORIGIN
  app.use(cors());
  app.options('*', cors());
}

app.use(express.json({ limit: '1mb' }));

// ------------------------ OpenAI Client ------------------------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  organization: process.env.OPENAI_ORG_ID || process.env.OPENAI_ORG || undefined,
  project: process.env.OPENAI_PROJECT_ID || process.env.OPENAI_PROJECT || undefined,
});

// ------------------------ Utilities ------------------------
function clean(v) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

function buildMessages(details) {
  const systemMessage = {
    role: 'system',
    content:
      'You are an expert consular assistant. You write professional, embassy-acceptable visa cover letters. Use a formal tone, short clear paragraphs, and never invent facts.',
  };

  const formatGuide = {
    role: 'user',
    content: `Structure:
1) Applicant contact (if provided) + current date
2) Embassy block (if provided)
3) Subject: "Application for [Visa Type] to [Destination]"
4) Salutation
5) Body: identity & travel dates; employment/income; funding & accommodation; supporting documents; strong ties & return assurance
6) Closing: "Sincerely," + full name
Plain text only.`,
  };

  const userInstruction = {
    role: 'user',
    content: `Use these details to draft the cover letter (omit fields not provided):
${details.map((l) => '- ' + l).join('\n')}`,
  };

  return [systemMessage, formatGuide, userInstruction];
}

// Use gpt-5-mini safely (no temperature/max_tokens); fallback once if needed
async function createLetter(messages) {
  const isGPT5Mini = /^gpt-5-mini/.test(MODEL_NAME);

  try {
    if (isGPT5Mini) {
      const resp = await openai.chat.completions.create({
        model: MODEL_NAME,
        messages,
        // For length limiting with gpt-5-mini, use max_completion_tokens (optional):
        // max_completion_tokens: 800,
      });
      return resp.choices?.[0]?.message?.content?.trim();
    } else {
      const resp = await openai.chat.completions.create({
        model: MODEL_NAME,
        messages,
        temperature: 0.2,
        max_tokens: 800,
      });
      return resp.choices?.[0]?.message?.content?.trim();
    }
  } catch (err) {
    console.error('Primary model failed:', err?.message || err);
    if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL_NAME) {
      const resp = await openai.chat.completions.create({
        model: FALLBACK_MODEL,
        messages,
        temperature: 0.2,
        max_tokens: 800,
      });
      return resp.choices?.[0]?.message?.content?.trim();
    }
    throw err;
  }
}

// ------------------------ Health ------------------------
app.get('/', (_req, res) => res.send('✅ Visa Letter API is running'));
app.get('/health', (_req, res) => res.json({ ok: true, model: MODEL_NAME }));

// ------------------------ Main Endpoint ------------------------
app.post('/generate-letter', async (req, res) => {
  try {
    const b = req.body || {};

    const payload = {
      // Personal
      name: clean(b.name),
      age: clean(b.age),
      nationality: clean(b.nationality),
      applicantAddress: clean(b.applicantAddress),
      contactPhone: clean(b.contactPhone),
      contactEmail: clean(b.contactEmail),
      dateOfBirth: clean(b.dateOfBirth),
      passportNumber: clean(b.passportNumber),
      passportIssueDate: clean(b.passportIssueDate),
      passportExpiryDate: clean(b.passportExpiryDate),
      maritalStatus: clean(b.maritalStatus),
      numDependents: clean(b.numDependents),

      // Travel
      destination: clean(b.destination),
      visaType: clean(b.visaType),
      purpose: clean(b.purpose),
      travelDates: clean(b.travelDates),
      entryDate: clean(b.entryDate),
      stayDuration: clean(b.stayDuration),
      invited: clean(b.invited),
      inviterName: clean(b.inviterName),
      inviterAddress: clean(b.inviterAddress),
      inviterRelationship: clean(b.inviterRelationship),
      inviterDocs: clean(b.inviterDocs),
      stayDetails: clean(b.stayDetails),
      travelItinerary: clean(b.travelItinerary),

      // Employment & Finances
      occupation: clean(b.occupation),
      employerName: clean(b.employerName),
      employerAddress: clean(b.employerAddress),
      employmentDuration: clean(b.employmentDuration),
      income: clean(b.income),
      otherIncome: clean(b.otherIncome),
      funding: clean(b.funding),
      bankStatementDetails: clean(b.bankStatementDetails),
      significantTransactions: clean(b.significantTransactions),

      // Ties
      propertyDetails: clean(b.propertyDetails),
      businessCommitments: clean(b.businessCommitments),
      familyDependents: clean(b.familyDependents),
      otherCommitments: clean(b.otherCommitments),

      // History
      travelHistory: clean(b.travelHistory),
      visaRefusals: clean(b.visaRefusals),
      validVisas: clean(b.validVisas),

      // Sponsor
      sponsorSelf: clean(b.sponsorSelf),
      sponsorName: clean(b.sponsorName),
      sponsorRelationship: clean(b.sponsorRelationship),
      sponsorOccupation: clean(b.sponsorOccupation),
      sponsorIncome: clean(b.sponsorIncome),
      sponsorAccommodation: clean(b.sponsorAccommodation),
      sponsorDocs: clean(b.sponsorDocs),

      // Additional
      specialEvents: clean(b.specialEvents),
      compellingReasons: clean(b.compellingReasons),
      supportingLetters: clean(b.supportingLetters),
      potentialWeaknesses: clean(b.potentialWeaknesses),

      // Existing fields
      accommodation: clean(b.accommodation),
      documents: clean(b.documents),
      embassyName: clean(b.embassyName),
      embassyAddress: clean(b.embassyAddress),
      companyName: clean(b.companyName) || 'No Guide Travel Agent',
    };

    const required = ['name', 'age', 'nationality', 'destination', 'visaType', 'purpose', 'income'];
    const missing = required.filter((k) => !payload[k]);
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    // Build detail lines for the prompt
    const d = [];
    d.push(`Full Name: ${payload.name}`);
    d.push(`Age: ${payload.age}`);
    d.push(`Nationality: ${payload.nationality}`);
    if (payload.dateOfBirth) d.push(`Date of Birth: ${payload.dateOfBirth}`);
    if (payload.passportNumber) d.push(`Passport Number: ${payload.passportNumber}`);
    if (payload.passportIssueDate) d.push(`Passport Issue Date: ${payload.passportIssueDate}`);
    if (payload.passportExpiryDate) d.push(`Passport Expiry Date: ${payload.passportExpiryDate}`);
    if (payload.maritalStatus) d.push(`Marital Status: ${payload.maritalStatus}`);
    if (payload.numDependents) d.push(`Number of Dependents: ${payload.numDependents}`);
    if (payload.applicantAddress) d.push(`Address: ${payload.applicantAddress}`);
    if (payload.contactPhone) d.push(`Phone: ${payload.contactPhone}`);
    if (payload.contactEmail) d.push(`Email: ${payload.contactEmail}`);

    d.push(`Destination: ${payload.destination}`);
    d.push(`Visa Type: ${payload.visaType}`);
    if (payload.travelDates) d.push(`Travel Dates: ${payload.travelDates}`);
    if (payload.entryDate) d.push(`Entry Date: ${payload.entryDate}`);
    if (payload.stayDuration) d.push(`Duration of Stay: ${payload.stayDuration}`);
    d.push(`Purpose of Travel: ${payload.purpose}`);
    if (payload.invited) d.push(`Invited by someone in UK?: ${payload.invited}`);
    if (payload.inviterName) d.push(`Inviter Name: ${payload.inviterName}`);
    if (payload.inviterAddress) d.push(`Inviter Address: ${payload.inviterAddress}`);
    if (payload.inviterRelationship) d.push(`Inviter Relationship: ${payload.inviterRelationship}`);
    if (payload.inviterDocs) d.push(`Inviter Documents: ${payload.inviterDocs}`);
    if (payload.stayDetails) d.push(`Stay Details: ${payload.stayDetails}`);
    if (payload.travelItinerary) d.push(`Travel Itinerary: ${payload.travelItinerary}`);

    if (payload.occupation) d.push(`Occupation: ${payload.occupation}`);
    if (payload.employerName) d.push(`Employer/Business Name: ${payload.employerName}`);
    if (payload.employerAddress) d.push(`Employer/Business Address: ${payload.employerAddress}`);
    if (payload.employmentDuration) d.push(`Employment Duration: ${payload.employmentDuration}`);
    d.push(`Monthly Income: ${payload.income}`);
    if (payload.otherIncome) d.push(`Other Income: ${payload.otherIncome}`);
    d.push(`Funding Source: ${payload.funding || 'Self-funded'}`);
    if (payload.bankStatementDetails) d.push(`Bank Statement Details: ${payload.bankStatementDetails}`);
    if (payload.significantTransactions) d.push(`Significant Transactions: ${payload.significantTransactions}`);

    if (payload.accommodation) d.push(`Accommodation: ${payload.accommodation}`);
    if (payload.documents) d.push(`Supporting Documents: ${payload.documents}`);

    if (payload.propertyDetails) d.push(`Property Details: ${payload.propertyDetails}`);
    if (payload.businessCommitments) d.push(`Business/Employment Commitments: ${payload.businessCommitments}`);
    if (payload.familyDependents) d.push(`Family/Dependents: ${payload.familyDependents}`);
    if (payload.otherCommitments) d.push(`Other Commitments: ${payload.otherCommitments}`);

    if (payload.travelHistory) d.push(`Travel History: ${payload.travelHistory}`);
    if (payload.visaRefusals) d.push(`Visa Refusals: ${payload.visaRefusals}`);
    if (payload.validVisas) d.push(`Valid Visas: ${payload.validVisas}`);

    if (payload.sponsorSelf) d.push(`Self-sponsored: ${payload.sponsorSelf}`);
    if (payload.sponsorName) d.push(`Sponsor Name: ${payload.sponsorName}`);
    if (payload.sponsorRelationship) d.push(`Sponsor Relationship: ${payload.sponsorRelationship}`);
    if (payload.sponsorOccupation) d.push(`Sponsor Occupation: ${payload.sponsorOccupation}`);
    if (payload.sponsorIncome) d.push(`Sponsor Income: ${payload.sponsorIncome}`);
    if (payload.sponsorAccommodation) d.push(`Sponsor Accommodation Provided?: ${payload.sponsorAccommodation}`);
    if (payload.sponsorDocs) d.push(`Sponsor Documents: ${payload.sponsorDocs}`);

    if (payload.specialEvents) d.push(`Special Events: ${payload.specialEvents}`);
    if (payload.compellingReasons) d.push(`Compelling Reasons: ${payload.compellingReasons}`);
    if (payload.supportingLetters) d.push(`Supporting Letters/Docs: ${payload.supportingLetters}`);
    if (payload.potentialWeaknesses) d.push(`Potential Weaknesses: ${payload.potentialWeaknesses}`);

    d.push(`Company: ${payload.companyName}`);
    if (payload.embassyName) d.push(`Embassy Name: ${payload.embassyName}`);
    if (payload.embassyAddress) d.push(`Embassy Address: ${payload.embassyAddress}`);

    const messages = buildMessages(d);
    const letter = await createLetter(messages);
    if (!letter) return res.status(502).json({ error: 'The AI returned no content.' });

    return res.json({ letter });
  } catch (err) {
    console.error('Error generating letter:', err?.message || err);
    const status = err?.status || err?.statusCode || 500;
    return res.status(status).json({
      error: 'Failed to generate letter',
      detail: err?.message || 'unknown_error',
    });
  }
});

// ------------------------ Start ------------------------
app.listen(PORT, () => {
  console.log(`✅ Visa Letter API listening on http://localhost:${PORT}`);
});
