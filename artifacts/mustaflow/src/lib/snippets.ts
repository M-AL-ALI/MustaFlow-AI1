export type SnippetCategory = "Layout" | "Navigation" | "Forms" | "Data Display" | "Marketing";

export type Snippet = {
  id: string;
  name: string;
  description: string;
  category: SnippetCategory;
  prompt: string;
};

export const SNIPPETS: Snippet[] = [
  // Layout
  {
    id: "hero-section",
    name: "Hero Section",
    description: "Full-width hero with headline, subtext, and CTA button",
    category: "Layout",
    prompt:
      "Add a full-width hero section at the top of index.html with a bold headline, supporting subtitle, and a prominent call-to-action button. Use the existing color scheme and Tailwind classes.",
  },
  {
    id: "feature-grid",
    name: "Feature Grid",
    description: "3-column grid of feature cards with icons",
    category: "Layout",
    prompt:
      "Add a feature grid section with 3 columns of cards, each with a lucide icon, bold title, and short description. Integrate it below the hero or main content area.",
  },
  {
    id: "footer",
    name: "Footer",
    description: "Site footer with links, branding, and copyright",
    category: "Layout",
    prompt:
      "Add a professional footer to index.html with the site name, a few navigation links (Home, About, Contact, Privacy), and a copyright notice. Keep it consistent with the site's design.",
  },
  {
    id: "stat-card",
    name: "Stat Cards",
    description: "Row of metric/KPI stat cards with numbers and labels",
    category: "Layout",
    prompt:
      "Add a row of 3–4 stat cards showing key metrics (e.g. users, revenue, uptime). Each card has a large bold number, a label, and optionally a small trend indicator. Place them in a logical section.",
  },
  {
    id: "timeline",
    name: "Timeline",
    description: "Vertical timeline for steps, history, or progress",
    category: "Layout",
    prompt:
      "Add a vertical timeline section with 4–5 entries. Each entry has a dot connector, a date/step label, a title, and a short description. Style it to match the current design.",
  },

  // Navigation
  {
    id: "navigation-bar",
    name: "Navigation Bar",
    description: "Sticky top nav with logo, links, and a CTA button",
    category: "Navigation",
    prompt:
      "Add or improve the navigation bar in index.html. It should be sticky at the top, include a logo/brand name on the left, navigation links in the centre or right, and a CTA button (e.g. 'Get started'). Make it responsive with a mobile hamburger menu.",
  },
  {
    id: "stepper",
    name: "Stepper",
    description: "Step-by-step wizard progress indicator",
    category: "Navigation",
    prompt:
      "Add a horizontal stepper component showing 4 steps with labels. The active step is highlighted. Clicking steps navigates the user through a multi-step flow. Integrate it into a form or wizard section.",
  },
  {
    id: "tabs",
    name: "Tab Bar",
    description: "Horizontal tab navigation for switching content panels",
    category: "Navigation",
    prompt:
      "Add a horizontal tab bar with 3–4 tabs that switch between content panels. Use smooth transitions between panels. Style consistently with the existing design.",
  },

  // Forms
  {
    id: "contact-form",
    name: "Contact Form",
    description: "Name, email, message form with validation and success state",
    category: "Forms",
    prompt:
      "Add a contact form with name, email, subject, and message fields. Include client-side validation with inline error messages and a friendly success state after submit. Do not post to a real server.",
  },
  {
    id: "login-form",
    name: "Login Form",
    description: "Email/password login with remember me and forgot password",
    category: "Forms",
    prompt:
      "Add a clean login form with email and password fields, a 'Remember me' checkbox, and a 'Forgot password?' link. Include client-side validation. Show a mock success state when submitted. Style it to match the design.",
  },
  {
    id: "modal",
    name: "Modal Dialog",
    description: "Accessible overlay dialog with header, body, and actions",
    category: "Forms",
    prompt:
      "Add a modal/dialog component triggered by a button. The modal has a title, content area, a close button (X icon), and Cancel/Confirm action buttons. It should trap focus and close on backdrop click or Escape key.",
  },
  {
    id: "toast-notification",
    name: "Toast Notification",
    description: "Dismissible toast/snackbar for success, error, or info messages",
    category: "Forms",
    prompt:
      "Add a toast notification system that shows dismissible messages in the bottom-right corner. Include variants for success (green), error (red), and info (blue). Demo it with a button that triggers each type.",
  },

  // Data Display
  {
    id: "data-table",
    name: "Data Table",
    description: "Sortable, paginated table with mock data",
    category: "Data Display",
    prompt:
      "Add a data table with at least 5 columns and 8–10 rows of realistic mock data appropriate for this app. Include column sorting (click header), and simple pagination controls. Style it consistently.",
  },
  {
    id: "image-gallery",
    name: "Image Gallery",
    description: "Responsive grid gallery with lightbox on click",
    category: "Data Display",
    prompt:
      "Add a responsive image gallery with a 3-column grid of images from https://picsum.photos/. Clicking an image opens a lightbox overlay with prev/next navigation and a close button.",
  },
  {
    id: "progress-bar",
    name: "Progress Bar",
    description: "Animated progress bars with labels and percentages",
    category: "Data Display",
    prompt:
      "Add a progress bar section with 3–4 skill or metric bars. Each has a label, percentage value, and an animated fill using CSS transitions. Integrate it into an appropriate section of the page.",
  },
  {
    id: "countdown-timer",
    name: "Countdown Timer",
    description: "Live countdown to a target date with days/hours/min/sec",
    category: "Data Display",
    prompt:
      "Add a live countdown timer counting down to a target date 30 days in the future. Display days, hours, minutes, and seconds in styled boxes that update every second using JavaScript.",
  },
  {
    id: "kanban-board",
    name: "Kanban Board",
    description: "3-column Kanban with draggable cards",
    category: "Data Display",
    prompt:
      "Add a Kanban board with 3 columns (To Do, In Progress, Done) and 2–3 draggable cards in each column. Use the HTML Drag and Drop API to move cards between columns. Style consistently with the app.",
  },

  // Marketing
  {
    id: "pricing-table",
    name: "Pricing Table",
    description: "3-tier pricing cards with feature lists and CTA buttons",
    category: "Marketing",
    prompt:
      "Add a pricing section with 3 plan tiers (e.g. Free, Pro, Enterprise). Each card lists 4–6 features (checkmarks), a price, and a CTA button. Highlight the recommended plan with a badge.",
  },
  {
    id: "testimonial-carousel",
    name: "Testimonial Carousel",
    description: "Auto-rotating customer quote carousel",
    category: "Marketing",
    prompt:
      "Add a testimonial carousel that auto-rotates every 4 seconds. Each slide shows an avatar (from https://picsum.photos/), name, role, and a quote. Include prev/next dots and manual navigation.",
  },
  {
    id: "faq-accordion",
    name: "FAQ Accordion",
    description: "Expandable Q&A accordion section",
    category: "Marketing",
    prompt:
      "Add an FAQ section with 5–6 questions in an accordion. Each item expands to show the answer with a smooth animation. Only one item can be open at a time. Add appropriate questions relevant to this app.",
  },
  {
    id: "cta-banner",
    name: "CTA Banner",
    description: "High-contrast call-to-action banner with headline and button",
    category: "Marketing",
    prompt:
      "Add a prominent CTA banner section with a bold headline, one-line supporting text, and two buttons (primary action + secondary link). Use a contrasting background to make it stand out.",
  },
];

export const SNIPPET_CATEGORIES: SnippetCategory[] = [
  "Layout",
  "Navigation",
  "Forms",
  "Data Display",
  "Marketing",
];
