# Shadow Nexus AI Studio — Cloudflare Worker

## Deploy in 5 Minutes (Browser Only — No Terminal)

### Step 1: Create a Cloudflare Account
Go to https://cloudflare.com and sign up free.

### Step 2: Create the Worker
1. Go to https://workers.cloudflare.com
2. Click **"Create a Worker"**
3. Delete all existing code in the editor
4. Paste the contents of **index.js** from this folder
5. Click **"Save and Deploy"**
6. Copy your Worker URL — it looks like:
   `https://shadow-nexus-ai.YOUR-SUBDOMAIN.workers.dev`

### Step 3: Add Your OpenAI Secret
1. In your Worker dashboard, click **"Settings"** → **"Variables"**
2. Scroll to **"Environment Variables"**
3. Click **"Add variable"**
4. Set:
   - Variable name: `OPENAI_API_KEY`
   - Value: `sk-your-openai-key-here`
   - Check **"Encrypt"** ← this keeps it secret
5. Click **"Save and deploy"**

### Step 4: (Optional) Set the AI Model
Add another variable:
- Name: `OPENAI_MODEL`
- Value: `gpt-4o` (or `gpt-4o-mini` for faster/cheaper)

### Step 5: Connect to the Frontend
Set your Worker URL as the backend in your GitHub Pages frontend.
See the main Deployment Guide for details.

## Your Worker URL
After deploying: `https://shadow-nexus-ai.YOUR-SUBDOMAIN.workers.dev`

## Security
- Your OPENAI_API_KEY is stored as an encrypted secret on Cloudflare
- It NEVER appears in the Worker code visible to the browser
- The Worker enforces rate limiting (20 requests/minute per IP)
- CORS is configured to allow your frontend domain
