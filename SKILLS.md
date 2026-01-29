# SKILLS.md - Workflows & Procedures

This file documents workflows for common tasks that require browser automation, login sequences, or multi-step processes.

---

## Template: Service Login

**Purpose:** Generic template for documenting a login workflow.

**URL:** https://example.com

**User Credentials:**
- Email: [configured in setup or API_KEYS.md]
- Password: [configured in setup or API_KEYS.md]

**Login Options:**
- Continue with Google
- Continue with email
- SSO (if applicable)

**Steps:**

1. Navigate to the service login page
2. Click the appropriate login method
3. Enter credentials when prompted
4. Handle 2FA if required:
   - For Google 2FA: Select "Tap Yes on phone/tablet"
   - Wait for user confirmation before proceeding
5. Verify successful login
6. Proceed with the intended task

**Notes:**
- Document any service-specific quirks here
- Include error handling tips
- Note rate limits or special requirements

---

## Template: API Key Generation

**Purpose:** Template for documenting API key generation for a service.

**URL:** https://example.com/api-keys

**Prerequisites:**
- Must be logged in (see login workflow above)
- May require billing/payment setup

**Steps:**

1. Navigate to API Keys section
2. Click "Create API key" or equivalent
3. Enter key name/description
4. Select permissions (if applicable)
5. **IMPORTANT:** Copy the key immediately - often shown only once!
6. Store the key in `API_KEYS.md`

**Key Format:**
- Example: `sk-xxx...` or `api_xxx...`

**API Endpoint:**
- Base URL: `https://api.example.com/v1`
- Authentication: Bearer token in header

**Sample Request:**
```shell
curl https://api.example.com/v1/endpoint \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"key": "value"}'
```

---

## How to Add New Workflows

When you successfully complete a new login or API key generation:

1. Copy the appropriate template above
2. Fill in the actual URLs, steps, and details
3. Include any screenshots or specific UI element names
4. Document error cases you encountered
5. Add the workflow to this file

This helps future sessions repeat the process correctly.

---

*Add new workflows as they are discovered/documented.*
