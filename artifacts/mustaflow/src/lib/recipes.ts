export interface RecipeField {
  key: string;
  label: string;
  placeholder: string;
  type: "text" | "email" | "url" | "select" | "textarea";
  options?: string[];
  required?: boolean;
}

export interface RecipeDefinition {
  id: string;
  title: string;
  description: string;
  icon: string;
  category: RecipeCategory;
  difficulty: "Easy" | "Medium" | "Advanced";
  estimatedMinutes: number;
  tags: string[];
  fields: RecipeField[];
  promptTemplate: string;
}

export type RecipeCategory =
  | "Forms & Capture"
  | "Payments"
  | "Analytics"
  | "Marketing"
  | "Navigation & UI"
  | "Auth & Access"
  | "Content"
  | "Integrations"
  | "SEO";

export const RECIPE_CATEGORIES: RecipeCategory[] = [
  "Forms & Capture",
  "Payments",
  "Analytics",
  "Marketing",
  "Navigation & UI",
  "Auth & Access",
  "Content",
  "Integrations",
  "SEO",
];

export const RECIPE_CATEGORY_COLORS: Record<RecipeCategory, string> = {
  "Forms & Capture": "bg-blue-500/10 text-blue-400 border-blue-500/20",
  Payments: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  Analytics: "bg-violet-500/10 text-violet-400 border-violet-500/20",
  Marketing: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  "Navigation & UI": "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  "Auth & Access": "bg-orange-500/10 text-orange-400 border-orange-500/20",
  Content: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  Integrations: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  SEO: "bg-green-500/10 text-green-400 border-green-500/20",
};

export const RECIPES: RecipeDefinition[] = [
  {
    id: "contact-form",
    title: "Contact Form",
    description: "Add a professional contact form with name, email, message fields, and a success confirmation",
    icon: "Mail",
    category: "Forms & Capture",
    difficulty: "Easy",
    estimatedMinutes: 2,
    tags: ["form", "contact", "email"],
    fields: [
      {
        key: "businessName",
        label: "Your business name",
        placeholder: "e.g. Acme Services",
        type: "text",
        required: true,
      },
      {
        key: "emailAddress",
        label: "Email address to receive messages",
        placeholder: "e.g. hello@example.com",
        type: "email",
        required: true,
      },
      {
        key: "formTitle",
        label: "Form heading (optional)",
        placeholder: "e.g. Get in Touch, Request a Quote",
        type: "text",
      },
    ],
    promptTemplate:
      "Add a professional contact form section to the existing site. Business name: {{businessName}}. The form should collect: full name, email address, and message (textarea). Add a subject dropdown with 3–4 options relevant to {{businessName}}. When submitted, show a friendly success confirmation message with the email {{emailAddress}} mentioned. Style the form to match the existing design. Place it in a clearly labelled section.",
  },
  {
    id: "stripe-checkout",
    title: "Stripe Checkout",
    description: "Add a Stripe-powered payment button and checkout flow for selling products or services",
    icon: "CreditCard",
    category: "Payments",
    difficulty: "Medium",
    estimatedMinutes: 5,
    tags: ["stripe", "payment", "checkout", "ecommerce"],
    fields: [
      {
        key: "productName",
        label: "Product or service name",
        placeholder: "e.g. Premium Plan, Design Consultation",
        type: "text",
        required: true,
      },
      {
        key: "price",
        label: "Price",
        placeholder: "e.g. $49, $99/month",
        type: "text",
        required: true,
      },
      {
        key: "description",
        label: "Short product description",
        placeholder: "e.g. One hour strategy session with our team",
        type: "textarea",
      },
    ],
    promptTemplate:
      "Add a Stripe checkout integration to the site. Product: {{productName}} at {{price}}. Description: {{description}}. Add a prominent 'Buy Now' or 'Get Started' button that initiates a Stripe Checkout session. Use a placeholder STRIPE_PUBLIC_KEY from project secrets. Show the product name, price, and description clearly before the buy button. Add a success page/state and a cancel/back state. Include a secure checkout badge near the button.",
  },
  {
    id: "newsletter-signup",
    title: "Newsletter Signup",
    description: "Add an email newsletter signup with a compelling offer and Mailchimp or Resend integration",
    icon: "Send",
    category: "Forms & Capture",
    difficulty: "Easy",
    estimatedMinutes: 3,
    tags: ["newsletter", "email", "mailchimp", "resend", "marketing"],
    fields: [
      {
        key: "headline",
        label: "Signup headline",
        placeholder: "e.g. Get weekly tips in your inbox",
        type: "text",
        required: true,
      },
      {
        key: "incentive",
        label: "Incentive / lead magnet (optional)",
        placeholder: "e.g. Free checklist, 10% off your first order",
        type: "text",
      },
      {
        key: "platform",
        label: "Email platform",
        placeholder: "Choose one",
        type: "select",
        options: ["Mailchimp", "Resend", "ConvertKit", "Beehiiv", "General (no platform)"],
        required: true,
      },
    ],
    promptTemplate:
      "Add a newsletter signup section to the site. Headline: '{{headline}}'. Incentive offered: {{incentive}}. Email platform: {{platform}}. The signup should collect first name and email address. Show a short benefit list (2–3 bullets) of what subscribers get. After submission show a warm confirmation message. Add a privacy note ('No spam, unsubscribe any time'). Use NEWSLETTER_API_KEY from project secrets for the {{platform}} integration placeholder. Style to match the existing design.",
  },
  {
    id: "google-analytics",
    title: "Google Analytics",
    description: "Add Google Analytics 4 tracking to measure visitors, traffic sources, and behavior",
    icon: "BarChart3",
    category: "Analytics",
    difficulty: "Easy",
    estimatedMinutes: 2,
    tags: ["analytics", "google", "tracking", "ga4"],
    fields: [
      {
        key: "measurementId",
        label: "GA4 Measurement ID",
        placeholder: "e.g. G-XXXXXXXXXX (leave blank to use placeholder)",
        type: "text",
      },
    ],
    promptTemplate:
      "Add Google Analytics 4 to the site. Measurement ID: {{measurementId}} (use 'G-XXXXXXXXXX' as placeholder if not provided). Add the GA4 script tags to the <head> of index.html and every HTML page. Add basic pageview tracking. Add event tracking for any CTA button clicks, form submissions, and any 'Buy' or 'Contact' buttons. Add a comment explaining where to replace the Measurement ID with the real one from project secrets (GA4_MEASUREMENT_ID).",
  },
  {
    id: "posthog",
    title: "PostHog Analytics",
    description: "Add PostHog for product analytics, session recordings, and feature flags",
    icon: "LineChart",
    category: "Analytics",
    difficulty: "Easy",
    estimatedMinutes: 2,
    tags: ["posthog", "analytics", "product", "heatmap"],
    fields: [
      {
        key: "projectKey",
        label: "PostHog Project API Key",
        placeholder: "e.g. phc_XXXXXXX (leave blank to use placeholder)",
        type: "text",
      },
    ],
    promptTemplate:
      "Integrate PostHog analytics into the site. Project API key: {{projectKey}} (use placeholder 'phc_XXXXXXXXXXXX' if not provided). Add the PostHog snippet to the <head> of all HTML files pointing to 'https://app.posthog.com'. Initialize PostHog with posthog.init(). Add posthog.capture() calls for key user actions: form submissions, CTA button clicks, page navigation. Add a comment block explaining where the real POSTHOG_API_KEY secret should go.",
  },
  {
    id: "pricing-table",
    title: "Pricing Table",
    description: "Add a beautiful 3-tier pricing section with monthly/annual toggle and feature comparison",
    icon: "DollarSign",
    category: "Marketing",
    difficulty: "Easy",
    estimatedMinutes: 3,
    tags: ["pricing", "plans", "saas", "conversion"],
    fields: [
      {
        key: "tier1Name",
        label: "Starter plan name & price",
        placeholder: "e.g. Starter — $9/month",
        type: "text",
        required: true,
      },
      {
        key: "tier2Name",
        label: "Pro plan name & price (recommended)",
        placeholder: "e.g. Pro — $29/month",
        type: "text",
        required: true,
      },
      {
        key: "tier3Name",
        label: "Enterprise plan name & price",
        placeholder: "e.g. Enterprise — Custom",
        type: "text",
        required: true,
      },
      {
        key: "features",
        label: "Top 3 features to highlight",
        placeholder: "e.g. Unlimited projects, Priority support, Team collaboration",
        type: "textarea",
      },
    ],
    promptTemplate:
      "Add a pricing section to the existing site with 3 tiers: {{tier1Name}}, {{tier2Name}} (highlighted as recommended), and {{tier3Name}}. Key features to highlight: {{features}}. Include a monthly/annual billing toggle that shows 20% discount for annual. Each plan card should list 5–6 features with checkmarks (grayed out for lower tiers). Add a 'Get started' CTA button per plan. Close the section with a money-back guarantee note and a FAQ callout. Design: match the existing site style.",
  },
  {
    id: "testimonials",
    title: "Testimonials Section",
    description: "Add a social proof section with customer testimonials, star ratings, and company logos",
    icon: "Star",
    category: "Marketing",
    difficulty: "Easy",
    estimatedMinutes: 2,
    tags: ["testimonials", "social proof", "reviews", "trust"],
    fields: [
      {
        key: "businessType",
        label: "What is your business?",
        placeholder: "e.g. web design agency, bakery, consulting firm",
        type: "text",
        required: true,
      },
      {
        key: "style",
        label: "Display style",
        placeholder: "Choose one",
        type: "select",
        options: ["Cards grid", "Large quote cards", "Carousel / slider", "Wall of love"],
        required: true,
      },
    ],
    promptTemplate:
      "Add a testimonials section to the existing site for a {{businessType}}. Style: {{style}}. Create 6 realistic testimonials with: full name, job title/company, star rating (4-5 stars), and a 2–3 sentence review focused on results achieved. Include a section headline like 'What our customers say' and a summary stat (e.g. '4.9/5 average rating from 200+ reviews'). Add a row of company logo placeholders at the bottom. Make testimonials feel authentic, specific, and result-oriented.",
  },
  {
    id: "faq",
    title: "FAQ Accordion",
    description: "Add a frequently asked questions section with expandable answers",
    icon: "HelpCircle",
    category: "Content",
    difficulty: "Easy",
    estimatedMinutes: 2,
    tags: ["faq", "questions", "support", "accordion"],
    fields: [
      {
        key: "businessType",
        label: "What is your business or product?",
        placeholder: "e.g. online bakery, SaaS tool, consulting service",
        type: "text",
        required: true,
      },
      {
        key: "questionCount",
        label: "Number of questions",
        placeholder: "Choose one",
        type: "select",
        options: ["6 questions", "8 questions", "10 questions", "12 questions"],
        required: true,
      },
    ],
    promptTemplate:
      "Add a FAQ section to the existing site for a {{businessType}}. Generate {{questionCount}} realistic, helpful FAQ items as an accordion (click to expand). Questions should cover: pricing, how it works, refund/cancellation policy, support, getting started, and common concerns specific to {{businessType}}. Each answer should be 2–4 sentences. Include a section headline and a closing CTA like 'Still have questions? Contact us'. Style to match the existing design.",
  },
  {
    id: "hero-cta",
    title: "Hero with CTA",
    description: "Add a compelling hero section with headline, subtext, and a primary call-to-action",
    icon: "Sparkles",
    category: "Marketing",
    difficulty: "Easy",
    estimatedMinutes: 2,
    tags: ["hero", "cta", "landing", "conversion"],
    fields: [
      {
        key: "headline",
        label: "Main headline",
        placeholder: "e.g. The fastest way to ship your product",
        type: "text",
        required: true,
      },
      {
        key: "subtext",
        label: "Supporting text",
        placeholder: "e.g. Join thousands of makers who build with MustaFlow",
        type: "textarea",
      },
      {
        key: "ctaText",
        label: "CTA button text",
        placeholder: "e.g. Get Started Free, Book a Demo",
        type: "text",
        required: true,
      },
    ],
    promptTemplate:
      "Add or replace the hero section with a bold, conversion-focused design. Headline: '{{headline}}'. Supporting text: '{{subtext}}'. Primary CTA: '{{ctaText}}'. Add a secondary CTA link (e.g. 'See how it works' or 'Learn more'). Add 3 small trust signals below the CTA buttons (icons + short labels). Include a subtle animated background gradient or glow effect. Make the section full-width and visually impactful.",
  },
  {
    id: "image-gallery",
    title: "Image Gallery",
    description: "Add a responsive photo or work gallery with lightbox preview",
    icon: "Image",
    category: "Content",
    difficulty: "Easy",
    estimatedMinutes: 2,
    tags: ["gallery", "photos", "portfolio", "lightbox"],
    fields: [
      {
        key: "galleryTitle",
        label: "Gallery section title",
        placeholder: "e.g. Our Work, Photo Gallery, Portfolio",
        type: "text",
        required: true,
      },
      {
        key: "imageCount",
        label: "Number of images",
        placeholder: "Choose one",
        type: "select",
        options: ["6 images", "9 images", "12 images", "16 images"],
        required: true,
      },
      {
        key: "style",
        label: "Layout style",
        placeholder: "Choose one",
        type: "select",
        options: ["Masonry grid", "Uniform grid", "Horizontal scroll", "Featured + grid"],
      },
    ],
    promptTemplate:
      "Add an image gallery section titled '{{galleryTitle}}' to the existing site. Show {{imageCount}} using images from https://picsum.photos (use different seed numbers for variety, e.g. https://picsum.photos/seed/1/600/400). Layout: {{style}}. Add a lightbox effect: clicking any image opens a full-screen overlay with the image, navigation arrows (prev/next), and a close button (X). Add a filter bar above the grid if the site has categories (e.g. All, Branding, Web, Photography). Style to match the existing design.",
  },
  {
    id: "video-embed",
    title: "Video Embed",
    description: "Add a YouTube or Vimeo video section with a thumbnail play button and responsive player",
    icon: "Play",
    category: "Content",
    difficulty: "Easy",
    estimatedMinutes: 2,
    tags: ["video", "youtube", "vimeo", "media"],
    fields: [
      {
        key: "videoUrl",
        label: "YouTube or Vimeo URL",
        placeholder: "e.g. https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        type: "url",
      },
      {
        key: "sectionTitle",
        label: "Section title",
        placeholder: "e.g. See it in action, Watch how it works",
        type: "text",
        required: true,
      },
    ],
    promptTemplate:
      "Add a video section with the title '{{sectionTitle}}' to the existing site. Embed the video: {{videoUrl}} (extract the video ID and use an iframe embed). If no URL is provided, use a placeholder thumbnail from https://picsum.photos/seed/video/1280/720 with a play button overlay that shows an alert 'Video coming soon'. Make the video responsive (16:9 aspect ratio). Add a short description below the video. Style the section with a contrasting background to draw attention.",
  },
  {
    id: "search-bar",
    title: "Search Bar",
    description: "Add a live search feature that filters content on the page as the user types",
    icon: "Search",
    category: "Navigation & UI",
    difficulty: "Medium",
    estimatedMinutes: 3,
    tags: ["search", "filter", "ux"],
    fields: [
      {
        key: "searchTarget",
        label: "What should be searchable?",
        placeholder: "e.g. blog posts, products, team members, FAQ items",
        type: "text",
        required: true,
      },
      {
        key: "placeholder",
        label: "Search placeholder text",
        placeholder: "e.g. Search articles..., Find a product...",
        type: "text",
      },
    ],
    promptTemplate:
      "Add a live search/filter feature to the {{searchTarget}} on the existing site. Search placeholder: '{{placeholder}}'. Implement client-side filtering in JavaScript — as the user types, instantly filter the visible items (no page reload). If no matches are found, show a friendly empty state ('No results for X — try a different term'). Add a clear (X) button inside the search input. Debounce the input by 200ms for performance. Position the search bar prominently above the content being searched.",
  },
  {
    id: "dark-mode-toggle",
    title: "Dark Mode Toggle",
    description: "Add a dark/light mode toggle that remembers the user's preference",
    icon: "Moon",
    category: "Navigation & UI",
    difficulty: "Medium",
    estimatedMinutes: 3,
    tags: ["dark mode", "theme", "toggle", "ux"],
    fields: [],
    promptTemplate:
      "Add a dark/light mode toggle to the existing site. Implementation: use CSS custom properties for all colors so switching is instant. Add a toggle button (sun/moon icon) to the header. On toggle, switch a 'dark' class on the <html> element. Persist the preference in localStorage and apply it on page load to avoid flash. Ensure sufficient color contrast in both modes (WCAG AA). Animate the toggle smoothly. Apply the theme consistently to all pages.",
  },
  {
    id: "google-login",
    title: "Login with Google",
    description: "Add a Google OAuth sign-in button for user authentication",
    icon: "LogIn",
    category: "Auth & Access",
    difficulty: "Advanced",
    estimatedMinutes: 5,
    tags: ["auth", "google", "oauth", "login"],
    fields: [
      {
        key: "appName",
        label: "App name (shown in Google consent screen)",
        placeholder: "e.g. My App",
        type: "text",
        required: true,
      },
      {
        key: "redirectPage",
        label: "Where should users land after login?",
        placeholder: "e.g. dashboard, profile, home",
        type: "text",
      },
    ],
    promptTemplate:
      "Add Google OAuth login to the site for {{appName}}. Add a 'Continue with Google' button styled per Google's brand guidelines (white background, Google logo, dark text). Use the Google Identity Services library (https://accounts.google.com/gsi/client). On successful login, show the user's name and avatar in the header and redirect to {{redirectPage}}. Store the session in localStorage. Use GOOGLE_CLIENT_ID from project secrets as a placeholder. Add a sign-out button that clears the session and reloads.",
  },
  {
    id: "calendar-booking",
    title: "Calendar Booking",
    description: "Add a Cal.com embed so visitors can book appointments directly on your site",
    icon: "CalendarPlus",
    category: "Integrations",
    difficulty: "Easy",
    estimatedMinutes: 2,
    tags: ["booking", "calendar", "cal.com", "appointments"],
    fields: [
      {
        key: "calUsername",
        label: "Cal.com username or link",
        placeholder: "e.g. yourname or https://cal.com/yourname/30min",
        type: "text",
        required: true,
      },
      {
        key: "sectionTitle",
        label: "Section title",
        placeholder: "e.g. Book a Free Consultation, Schedule a Demo",
        type: "text",
        required: true,
      },
    ],
    promptTemplate:
      "Add a Cal.com booking section titled '{{sectionTitle}}' to the existing site. Embed the Cal.com inline widget for {{calUsername}} using the Cal embed script (https://cal.com/embed.js). If the username looks like a full URL, extract the path. Add a compelling headline above the embed: '{{sectionTitle}}'. Add 2–3 benefit bullets about what the meeting includes. Make the embed responsive and consistent with the page design.",
  },
  {
    id: "live-chat",
    title: "Live Chat (Crisp)",
    description: "Add a Crisp live chat widget for real-time customer support",
    icon: "MessageCircle",
    category: "Integrations",
    difficulty: "Easy",
    estimatedMinutes: 2,
    tags: ["chat", "crisp", "support", "live chat"],
    fields: [
      {
        key: "websiteId",
        label: "Crisp Website ID",
        placeholder: "e.g. xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (leave blank for placeholder)",
        type: "text",
      },
    ],
    promptTemplate:
      "Add the Crisp live chat widget to all pages of the site. Website ID: {{websiteId}} (use a placeholder UUID if not provided). Insert the Crisp initialization script just before the closing </body> tag of index.html and every HTML page. Add a JavaScript comment explaining where to replace with the real CRISP_WEBSITE_ID from project secrets. Ensure the widget doesn't interfere with mobile layout.",
  },
  {
    id: "maps",
    title: "Interactive Map",
    description: "Add a Leaflet.js map with your location pinned and optional service area radius",
    icon: "MapPin",
    category: "Integrations",
    difficulty: "Medium",
    estimatedMinutes: 3,
    tags: ["map", "leaflet", "location", "openstreetmap"],
    fields: [
      {
        key: "locationName",
        label: "Location name",
        placeholder: "e.g. New York City, London, Sydney CBD",
        type: "text",
        required: true,
      },
      {
        key: "showRadius",
        label: "Show service area radius?",
        placeholder: "Choose one",
        type: "select",
        options: ["No radius", "5 mile radius", "10 mile radius", "25 mile radius", "50 mile radius"],
      },
      {
        key: "sectionTitle",
        label: "Section title",
        placeholder: "e.g. Find Us, Service Area, Our Location",
        type: "text",
      },
    ],
    promptTemplate:
      "Add an interactive map section titled '{{sectionTitle}}' showing {{locationName}} using Leaflet.js + OpenStreetMap (no API key required). Use realistic coordinates for {{locationName}}. Add a custom marker with a popup showing the location name and a short description. {{showRadius}} — add a circle overlay if a radius was chosen. Include the Leaflet CSS and JS from unpkg CDN. Make the map 420px tall and fully responsive. Add the location address below the map with a 'Get Directions' link to Google Maps.",
  },
  {
    id: "seo-meta-tags",
    title: "SEO Meta Tags",
    description: "Add comprehensive SEO meta tags, Open Graph, and Twitter card data to all pages",
    icon: "Globe",
    category: "SEO",
    difficulty: "Easy",
    estimatedMinutes: 2,
    tags: ["seo", "meta", "open graph", "twitter card"],
    fields: [
      {
        key: "siteName",
        label: "Site / business name",
        placeholder: "e.g. Acme Agency",
        type: "text",
        required: true,
      },
      {
        key: "description",
        label: "Site description (150–160 chars for best SEO)",
        placeholder: "e.g. Professional web design and development for small businesses",
        type: "textarea",
        required: true,
      },
      {
        key: "keywords",
        label: "Main keywords (comma-separated)",
        placeholder: "e.g. web design, web development, small business",
        type: "text",
      },
    ],
    promptTemplate:
      "Add comprehensive SEO meta tags to all HTML pages for {{siteName}}. In the <head> of every HTML file add: meta charset, viewport, description ('{{description}}'), keywords ('{{keywords}}'), robots (index, follow), canonical URL. Add Open Graph tags: og:title, og:description, og:type (website), og:site_name ({{siteName}}), og:image (use a placeholder or the first image on the page). Add Twitter card tags: twitter:card (summary_large_image), twitter:title, twitter:description, twitter:site. Add JSON-LD structured data (Organization schema) in a <script type='application/ld+json'> block. Ensure <title> tags are descriptive and unique per page.",
  },
  {
    id: "sitemap-robots",
    title: "Sitemap + Robots.txt",
    description: "Generate a sitemap.xml and robots.txt to help search engines index your site",
    icon: "FileSearch",
    category: "SEO",
    difficulty: "Easy",
    estimatedMinutes: 2,
    tags: ["sitemap", "robots", "seo", "search engine"],
    fields: [
      {
        key: "domainUrl",
        label: "Your site's URL",
        placeholder: "e.g. https://mysite.com",
        type: "url",
        required: true,
      },
      {
        key: "changeFreq",
        label: "How often does your content change?",
        placeholder: "Choose one",
        type: "select",
        options: ["Daily", "Weekly", "Monthly", "Rarely"],
        required: true,
      },
    ],
    promptTemplate:
      "Generate a sitemap.xml and robots.txt file for the site. Domain: {{domainUrl}}. Change frequency: {{changeFreq}}. sitemap.xml: Include a <url> entry for every HTML page in the project (index.html and any linked pages). Set <changefreq> to {{changeFreq | lowercase}}, <priority> appropriately (1.0 for home, 0.8 for main pages, 0.6 for secondary pages), and <lastmod> to today's date. robots.txt: Allow all user agents, disallow /admin/ and /private/, include the Sitemap URL. Add a <link rel='sitemap'> tag to the <head> of index.html pointing to /sitemap.xml.",
  },
];
