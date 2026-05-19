export interface TemplateDefinition {
  id: string;
  title: string;
  description: string;
  category: TemplateCategory;
  icon: string;
  projectKind: "web" | "fullstack" | "dashboard" | "automation" | "api";
  seedPrompt: string;
}

export type TemplateCategory =
  | "Marketing"
  | "Portfolio"
  | "SaaS"
  | "E-commerce"
  | "Content"
  | "Business Tools"
  | "Productivity"
  | "AI";

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  "Marketing",
  "Portfolio",
  "SaaS",
  "E-commerce",
  "Content",
  "Business Tools",
  "Productivity",
  "AI",
];

export const CATEGORY_COLORS: Record<TemplateCategory, string> = {
  Marketing: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  Portfolio: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  SaaS: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  "E-commerce": "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  Content: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  "Business Tools": "bg-orange-500/10 text-orange-400 border-orange-500/20",
  Productivity: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  AI: "bg-violet-500/10 text-violet-400 border-violet-500/20",
};

export const TEMPLATES: TemplateDefinition[] = [
  {
    id: "landing-page",
    title: "Landing Page",
    description: "High-converting product or service landing page with hero, features, and CTA",
    category: "Marketing",
    icon: "Rocket",
    projectKind: "web",
    seedPrompt:
      "Build a modern, high-converting landing page. Include a full-width hero section with a bold headline, subheading, and a prominent call-to-action button. Add a social proof section with 3 customer testimonials and star ratings. Include a features grid with 6 benefit-focused items, each with an icon, title, and short description. Add a pricing section with 3 tiers (Starter, Pro, Enterprise) and a clear recommended plan. Close with an FAQ accordion (5 questions) and a footer with links. Use a clean, professional design with a dark background and accent color highlights.",
  },
  {
    id: "portfolio",
    title: "Portfolio",
    description: "Professional portfolio to showcase your work, skills, and experience",
    category: "Portfolio",
    icon: "Briefcase",
    projectKind: "web",
    seedPrompt:
      "Build a sleek personal portfolio website. Start with a hero section that includes a professional greeting, a short bio paragraph, and links to GitHub and LinkedIn. Add a skills section displaying a grid of technology badges. Include a projects section showing 4 project cards, each with a title, description, tech stack tags, and GitHub/live demo links. Add a work experience timeline with 3 entries. Include a contact section with a simple form (name, email, message) and social links. Use smooth scroll navigation with a sticky header. Design should be minimal and elegant.",
  },
  {
    id: "saas-dashboard",
    title: "SaaS Dashboard",
    description: "Analytics dashboard with metrics, charts, and data tables",
    category: "SaaS",
    icon: "LayoutDashboard",
    projectKind: "dashboard",
    seedPrompt:
      "Build a SaaS analytics dashboard. Include a sidebar navigation with sections for Overview, Analytics, Users, Revenue, and Settings. The main overview page should show 4 stat cards (Total Revenue, Active Users, New Signups, Churn Rate) with trend indicators. Add a line chart showing revenue over the last 12 months and a bar chart for monthly active users. Include a recent activity feed and a top users table with avatar, name, plan, and MRR columns. Add a date range picker in the header. Use a dark theme with subtle card shadows and a clean data-dense layout.",
  },
  {
    id: "ecommerce-store",
    title: "E-commerce Store",
    description: "Online store with product grid, cart, and checkout flow",
    category: "E-commerce",
    icon: "ShoppingCart",
    projectKind: "fullstack",
    seedPrompt:
      "Build a modern e-commerce storefront. Include a header with logo, search bar, and cart icon with item count badge. Add a hero banner with a featured sale. Show a product grid of 12 items, each with an image placeholder, product name, price, rating stars, and an Add to Cart button. Include category filter tabs at the top. Add a slide-out cart drawer that shows added items, quantities, subtotal, and a checkout button. Include a simple product detail view with image, description, size selector, quantity input, and add to cart. Use a clean white/light theme with accent color.",
  },
  {
    id: "blog",
    title: "Blog",
    description: "Clean blog with article listing, featured posts, and reading experience",
    category: "Content",
    icon: "BookOpen",
    projectKind: "web",
    seedPrompt:
      "Build a clean, readable blog website. Include a header with logo, navigation (Home, Articles, About, Newsletter), and a dark mode toggle. Add a hero section with a featured article card. Show a grid of 6 article cards with cover image placeholders, category tag, title, excerpt, author avatar, date, and read time. Include a sidebar with a search box, popular tags cloud, and newsletter signup. Add a single article view with a full-width header image, article content with good typography, author bio card, and related articles at the bottom. Use a clean typographic design.",
  },
  {
    id: "booking-system",
    title: "Booking System",
    description: "Appointment and reservation system with calendar and availability",
    category: "Business Tools",
    icon: "CalendarCheck",
    projectKind: "fullstack",
    seedPrompt:
      "Build a professional booking and appointment system. Include a service selection step showing 4 service cards (e.g. Consultation, Strategy Session, Design Review, Workshop) with duration and price. Add a calendar view for date selection showing available and unavailable dates. Include a time slot picker showing available times in a grid format for the selected date. Add a booking form for customer details (name, email, phone, notes). Show a confirmation summary page with all booking details and a confirmation button. Include a 'My Bookings' view showing upcoming and past appointments. Use a professional, trustworthy design.",
  },
  {
    id: "invoice-generator",
    title: "Invoice Generator",
    description: "Professional invoice builder with line items, taxes, and PDF export",
    category: "Business Tools",
    icon: "FileText",
    projectKind: "fullstack",
    seedPrompt:
      "Build a professional invoice generator app. Include a form to fill in client details (name, company, email, address) and sender details. Add a line items table where users can add rows with description, quantity, unit price, and auto-calculated total. Include tax rate and discount fields. Show a live invoice preview panel on the right that updates in real time as the form is filled. The preview should look like a real professional invoice with logo area, invoice number, date, due date, itemized table, subtotal, tax, and grand total. Add a Print/Save as PDF button. Use a split-panel layout.",
  },
  {
    id: "kanban-board",
    title: "Kanban Board",
    description: "Task management board with drag-and-drop columns and cards",
    category: "Productivity",
    icon: "Columns",
    projectKind: "fullstack",
    seedPrompt:
      "Build a Kanban project management board. Show 4 columns: Backlog, In Progress, Review, and Done. Each column should display a card count badge and an Add Card button. Show 3–4 sample task cards per column, each with a title, priority badge (High/Medium/Low with color coding), assignee avatar, due date, and a tag. Include a top bar with project title, team member avatars, and a New Task button. Add a task detail modal that slides in when a card is clicked, showing full description, checklist, comments, and activity. Include column collapse functionality. Use a clean board layout with subtle card shadows.",
  },
  {
    id: "event-page",
    title: "Event Page",
    description: "Event landing page with schedule, speakers, and ticket registration",
    category: "Marketing",
    icon: "Calendar",
    projectKind: "web",
    seedPrompt:
      "Build an event landing page for a conference or meetup. Include a hero section with event name, tagline, date, location, and a Register Now CTA with a countdown timer. Add a speakers grid showing 6 speaker cards with photo placeholder, name, title, and company. Include a full schedule/agenda section with time slots organized by day (2 days), each showing session title, speaker, and room. Add a venue section with an embedded map placeholder and hotel recommendations. Include a sponsors section with logo placeholders in different tiers. Show ticket pricing cards with Early Bird, Standard, and VIP options. Close with a registration form.",
  },
  {
    id: "restaurant-menu",
    title: "Restaurant Menu",
    description: "Digital restaurant menu with categories, items, and online ordering",
    category: "E-commerce",
    icon: "UtensilsCrossed",
    projectKind: "web",
    seedPrompt:
      "Build a digital restaurant website and menu. Include a hero section with restaurant name, a mouthwatering tagline, hero image placeholder, and Make a Reservation / Order Online CTAs. Add a sticky category navigation (Appetizers, Mains, Pasta, Seafood, Desserts, Drinks). Show menu items in a well-spaced grid, each with image placeholder, name, description, dietary badges (vegan, gluten-free, spicy), and price. Include an About section with the restaurant story and chef photo. Add an online order flow: browse menu → add to cart → delivery/pickup toggle → checkout form. Include opening hours and a contact/map section.",
  },
  {
    id: "admin-panel",
    title: "Admin Panel",
    description: "Full-featured admin dashboard with user management and settings",
    category: "SaaS",
    icon: "Shield",
    projectKind: "dashboard",
    seedPrompt:
      "Build a comprehensive admin panel. Include a sidebar with sections: Dashboard, Users, Content, Analytics, Settings, and Logs. The Dashboard shows key metrics (Total Users, Revenue, Active Sessions, Error Rate) with sparkline charts. The Users section has a searchable, sortable data table with avatar, name, email, role badge, status toggle, and action menu (Edit, Suspend, Delete). Include a modal for editing user details. The Settings page has tabbed sections for General, Security, Notifications, and Billing. Add a dark/light theme toggle. Include breadcrumb navigation and a global search. Use a professional enterprise design.",
  },
  {
    id: "ai-chatbot",
    title: "AI Chatbot",
    description: "Conversational AI chat interface with message history and settings",
    category: "AI",
    icon: "Bot",
    projectKind: "fullstack",
    seedPrompt:
      "Build a polished AI chat interface. Include a sidebar showing chat history with conversation titles, a New Chat button, and model selector (GPT-4, Claude, Gemini). The main area should show a chat window with user messages on the right (dark bubble) and assistant messages on the left (lighter bubble) with a typing indicator animation. Include message timestamps, copy button on hover, and a thumbs up/down feedback on assistant messages. The input area should have a multiline textarea, send button, and attachment icon. Add a system prompt configuration panel that slides in from the right. Include a clean empty state when no conversation is selected. Use a modern chat app design.",
  },
  {
    id: "saas-pricing",
    title: "Pricing Page",
    description: "SaaS pricing page with plan comparison, FAQs, and trust signals",
    category: "SaaS",
    icon: "CreditCard",
    projectKind: "web",
    seedPrompt:
      "Build a high-converting SaaS pricing page. Start with a headline and subheading centered above the plans. Include a monthly/annual billing toggle that shows discounted annual prices. Show 3 pricing tiers (Starter at $9/mo, Pro at $29/mo, Enterprise at custom) as cards, with the Pro plan visually highlighted as recommended. Each card lists 6–8 features with checkmarks, and grayed-out features for lower tiers. Add a feature comparison table below the cards. Include a section with 3 customer logos and a quote. Add an FAQ accordion with 6 questions about billing, refunds, and features. Close with a free trial CTA banner. Use a clean design that builds trust.",
  },
  {
    id: "job-board",
    title: "Job Board",
    description: "Job listing site with search, filters, and application flow",
    category: "Business Tools",
    icon: "Search",
    projectKind: "fullstack",
    seedPrompt:
      "Build a modern job board website. Include a header with logo, Post a Job button, and sign-in link. Add a hero search section with job title input, location input, and a search button. Include filter chips for job type (Full-time, Part-time, Remote, Contract) and category tags. Show a list of 8 job listing cards, each with company logo placeholder, job title, company name, location, salary range, job type badge, and date posted. Clicking a listing opens a detail panel on the right (split view) with full job description, requirements, benefits, and an Apply Now button. Include a job application modal with name, email, resume upload, and cover letter fields.",
  },
  {
    id: "fitness-tracker",
    title: "Fitness Tracker",
    description: "Workout and health tracking app with progress charts and routines",
    category: "Productivity",
    icon: "Activity",
    projectKind: "fullstack",
    seedPrompt:
      "Build a fitness tracking web app. Include a dashboard showing today's stats: steps, calories, active minutes, and water intake as circular progress indicators. Add a weekly workout calendar with color-coded sessions. Show a workout log with recent sessions listing exercise name, sets, reps, and weight. Include a workout builder where users can add exercises to a routine from a searchable exercise library. Add a progress section with line charts for weight over time and strength PRs. Include a nutrition tracker with a daily macro breakdown (protein, carbs, fat) as a pie chart and a meal log. Use an energetic, motivating design with bold typography.",
  },
  {
    id: "link-in-bio",
    title: "Link in Bio",
    description: "Personal hub page with links, social profiles, and featured content",
    category: "Portfolio",
    icon: "Link",
    projectKind: "web",
    seedPrompt:
      "Build a stylish link-in-bio page. Show a centered profile with a large avatar placeholder, name, short bio, and location. Include 5–6 prominent link buttons with icons (YouTube Channel, Latest Article, Newsletter, Shop, Podcast, Instagram). Add a featured content section below with 3 cards for latest posts or projects with thumbnail, title, and description. Include social media icon links at the bottom (Twitter, LinkedIn, GitHub, Instagram, TikTok). Add subtle animated background or gradient. Support light and dark variants. The design should be personal, clean, and eye-catching — something a creator would proudly share.",
  },
];
