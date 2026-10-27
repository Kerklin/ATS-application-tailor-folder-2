# ATS Application Tailor

A one-page web app that takes your CV and a job description and produces:

1. Fit evaluation with verdict and 1–100 match score
2. HR prescreen (gaps, red flags, eligibility)
3. Tailoring recommendations
4. ATS keyword report (exact / synonym / missing, and where each was placed)
5. Full tailored CV (plain text, ATS-safe)
6. Full tailored cover letter
7. Salary expectations (with web search)
8. Suggested file names

Everything runs in your browser. There is no server. Your CV and JD are sent only to the AI provider you choose, using your own API key.

## Use it

1. Open the page.
2. Upload your CV (PDF, DOCX or TXT) or paste it. Check the extracted text.
3. Paste the JD text. A link also works if web search is on, but pasting is more reliable.
4. Choose provider, enter your API key, pick language and employer style.
5. Click **Analyse and tailor**. It takes 1–4 minutes.
6. Use the tabs to view each section. Copy it or download it as .txt or .doc.

## Publish on GitHub Pages

1. Create a new repository and upload the contents of this folder to its top level, including the `vendor` folder and the hidden `.nojekyll` file.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**, **Branch** to `main`, folder `/ (root)`. Click **Save**.
4. After 1–2 minutes the page is live at `https://YOUR-USERNAME.github.io/REPO-NAME/`.

## API keys

- Anthropic: console.anthropic.com → API keys. Web search must be enabled for your organisation in the console.
- OpenAI: platform.openai.com → API keys.

Set a monthly spending limit with your provider. Each run costs a small amount, more with web search.

## Privacy

- Never commit your CV or API key to the repository. A public repository is visible to everyone.
- The key is kept only in your browser, and only if you tick "Remember".
- Do not paste confidential employer documents into any AI service unless your organisation allows it.

## Changing the instructions

All instructions to the AI are in `prompt.js`. Edit the rules there to change tone, sections or formatting.

## Security

- No third-party scripts. The PDF reader (pdf.js 5.4.296, Apache-2.0) is included in `vendor/`. DOCX files are read by built-in browser code.
- A Content Security Policy allows scripts only from this site and network calls only to api.anthropic.com and api.openai.com.
- All AI output is displayed as plain text, never as HTML.
- The JD and CV are marked as data in the prompt, so instructions hidden inside a JD are ignored.

## Testing locally

Open it through a local server, not by double-clicking `index.html`:

```
python -m http.server 8000
```

Then go to http://localhost:8000. Browsers block the modules when a page is opened as a file.

## Limits

- Needs a current browser (Chrome, Edge or Firefox from 2024 on, Safari 17.4+).
- The page does not fetch vacancy links itself. Paste the JD text, or give the link with web search on.
- Scanned (image) PDFs have no text to extract. Use a DOCX or paste the text.
- The AI can still make mistakes. Check every claim against your real CV before submitting.
