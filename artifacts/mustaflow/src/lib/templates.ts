export interface TemplateDefinition {
  id: string;
  title: string;
  description: string;
  category: TemplateCategory;
  icon: string;
  projectKind: "web" | "fullstack" | "dashboard" | "automation" | "api" | "mobile-cross";
  seedPrompt: string;
  isStarterPack?: boolean;
  industry?: string;
}

export type TemplateCategory =
  | "Marketing"
  | "Portfolio"
  | "SaaS"
  | "E-commerce"
  | "Content"
  | "Business Tools"
  | "Productivity"
  | "AI"
  | "Mobile"
  | "Starter Packs";

export const TEMPLATE_CATEGORIES: TemplateCategory[] = [
  "Starter Packs",
  "Marketing",
  "Portfolio",
  "SaaS",
  "E-commerce",
  "Content",
  "Business Tools",
  "Productivity",
  "AI",
  "Mobile",
];

export const CATEGORY_COLORS: Record<TemplateCategory, string> = {
  "Starter Packs": "bg-amber-500/10 text-amber-400 border-amber-500/20",
  Marketing: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  Portfolio: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  SaaS: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  "E-commerce": "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  Content: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  "Business Tools": "bg-orange-500/10 text-orange-400 border-orange-500/20",
  Productivity: "bg-rose-500/10 text-rose-400 border-rose-500/20",
  AI: "bg-violet-500/10 text-violet-400 border-violet-500/20",
  Mobile: "bg-green-500/10 text-green-400 border-green-500/20",
};

export const STARTER_PACKS: TemplateDefinition[] = [
  {
    id: "sp-real-estate",
    title: "Real Estate Agency",
    description:
      "Multi-page listing site for real estate agents — property search, listings, agent profiles, and contact",
    category: "Starter Packs",
    icon: "Building2",
    projectKind: "web",
    isStarterPack: true,
    industry: "Real Estate",
    seedPrompt:
      "Build a complete multi-page real estate agency website. HOME PAGE: Hero section with a search bar (location, property type, price range), featured listings carousel (6 cards: image placeholder, address, price, beds, baths, sqft), and a 'Why Choose Us' section with 4 trust badges (Licensed Agents, 500+ Homes Sold, Local Experts, Free Valuation). LISTINGS PAGE: Filterable grid of 12 property cards, each with a photo placeholder, price, address, key stats, and a Save/Favorite button. A sidebar with filter controls (price range sliders, bedrooms, bathrooms, property type checkboxes). PROPERTY DETAIL: Full-width hero image, photo gallery strip, detailed stats table, description, features checklist, mortgage calculator, map placeholder, and a contact agent sidebar form. AGENTS PAGE: Team grid of 6 agent cards with photo placeholder, name, title, specialty tags, contact info. CONTACT PAGE: Office address and phone, Google Maps embed placeholder, inquiry form. Use a clean professional design with a navy/white/gold palette. Include a sticky header with logo, nav links, and a CTA button.",
  },
  {
    id: "sp-restaurant",
    title: "Restaurant & Dining",
    description: "Full restaurant site with digital menu, online reservations, hours, and location",
    category: "Starter Packs",
    icon: "UtensilsCrossed",
    projectKind: "web",
    isStarterPack: true,
    industry: "Restaurant",
    seedPrompt:
      "Build a complete multi-page restaurant website. HOME PAGE: Full-width hero with restaurant name, tagline, and two CTAs (Reserve a Table, View Menu). An atmosphere photo gallery strip (3 images), a brief story section with chef photo placeholder, and a featured dishes section (3 cards with image, name, description, price). Add opening hours block and a Google Maps placeholder. MENU PAGE: Sticky category nav (Starters, Mains, Pasta, Seafood, Grill, Desserts, Drinks). Menu items in a 2-column grid, each with image placeholder, name, description, dietary badges (Vegetarian, Vegan, Gluten-Free, Spicy), and price. RESERVATIONS PAGE: Reservation form with date picker, time slot selector, party size, name, email, phone, special requests. Show a confirmation success state. ABOUT PAGE: Restaurant story, team photos, awards, press logos. Include a full sticky header with navigation, and a footer with hours, address, phone, social links. Design: warm, upscale feel with dark background, cream/gold accents, elegant serif typography for headings.",
  },
  {
    id: "sp-portfolio-creator",
    title: "Creator Portfolio",
    description:
      "Multi-page portfolio for freelancers, designers, and photographers with project gallery and client inquiry",
    category: "Starter Packs",
    icon: "Palette",
    projectKind: "web",
    isStarterPack: true,
    industry: "Portfolio",
    seedPrompt:
      "Build a complete multi-page portfolio website for a creative professional. HOME PAGE: Bold hero with name, title (e.g. 'Visual Designer & Illustrator'), a tagline, and CTA buttons (View Work, Contact Me). An animated scrolling marquee of skills. A featured projects section showing 3 highlighted case study cards with project type, title, cover image placeholder, and 'View Project' link. Add a client logos strip (6 placeholder logos) and a short testimonial from a happy client. WORK/PROJECTS PAGE: Filterable masonry-style project grid (categories: All, Branding, Web, Print, Motion) showing 9 project cards. Clicking opens a case study modal with full description, tools used, challenge/solution/outcome sections, and image gallery placeholders. ABOUT PAGE: Professional photo placeholder, bio, skills grid with proficiency bars, work timeline, awards/publications. SERVICES PAGE: 3 service cards (e.g. Brand Identity, Web Design, Illustration) with description, what's included list, starting price, and 'Get a Quote' CTA. CONTACT PAGE: Friendly contact form with project type dropdown, budget range, timeline, and message. Include social links and a downloadable resume button. Design: minimal, dark, typographic — let the work speak. White space, subtle animations on scroll.",
  },
  {
    id: "sp-online-course",
    title: "Online Course",
    description:
      "Course landing page with curriculum, instructor bio, student testimonials, and enrollment",
    category: "Starter Packs",
    icon: "GraduationCap",
    projectKind: "web",
    isStarterPack: true,
    industry: "Education",
    seedPrompt:
      "Build a complete multi-page online course website. LANDING PAGE: Hero with course name, transformation headline ('Go from beginner to hired in 12 weeks'), a short video embed placeholder, and 'Enroll Now' CTA with enrollment counter and urgency copy. Add a 'What You'll Learn' section (8 outcome bullets with checkmarks), a curriculum accordion (6 modules, each expanding to show 4–6 lesson titles), an instructor bio section with photo placeholder, credentials, and social proof numbers (10k+ students, 4.9 stars). Include a 3-plan pricing section (Self-Paced $197, Guided $397, VIP Coaching $797). Add 6 student testimonials with photo, name, result achieved, and star rating. CURRICULUM PAGE: Full detailed module breakdown with lesson list, duration, preview tags. INSTRUCTOR PAGE: Full bio, credentials, other courses, media appearances, podcast links. FAQ PAGE: 10 common questions and answers accordion. ENROLLMENT PAGE: Checkout form with plan selector, payment details, money-back guarantee badge, secure checkout trust signals. Design: motivating, modern — use bold typography, gradient accents, plenty of social proof. Dark hero transitioning to light content sections.",
  },
  {
    id: "sp-local-services",
    title: "Local Services Business",
    description:
      "Lead-gen site for plumbers, electricians, contractors — service areas, pricing, and instant quote form",
    category: "Starter Packs",
    icon: "Wrench",
    projectKind: "web",
    isStarterPack: true,
    industry: "Home Services",
    seedPrompt:
      "Build a complete multi-page local services business website (suitable for plumber, electrician, HVAC, roofer, etc.). HOME PAGE: Hero with bold headline ('Your Local [Service] Experts'), phone number prominently displayed, and emergency call button. 3 trust badges (Licensed & Insured, Same-Day Service, Free Estimates). Services overview cards (6 services with icon, name, short description). A 'How It Works' section (3 steps: Call/Book → We Arrive → Problem Solved). 5-star review showcase. Service area map section. SERVICES PAGE: Detailed service cards, each with description, typical problems solved, pricing ranges, and a 'Get a Quote' button. PRICING PAGE: Transparent pricing table with common jobs and typical cost ranges, note about free estimates. REVIEWS PAGE: Grid of 12 customer reviews with name, location, rating, review text, and date. Overall rating summary. CONTACT/QUOTE PAGE: Multi-step quote request form (Step 1: Service Type → Step 2: Problem Description & Photos upload placeholder → Step 3: Contact Info & Preferred Time). Emergency contact section with large phone button. ABOUT PAGE: Company history, team photos, licenses/certifications, community involvement. Design: trustworthy, professional — use blue or green palette, bold typography, lots of social proof and trust signals.",
  },
  {
    id: "sp-wedding",
    title: "Wedding Site",
    description:
      "Romantic multi-page wedding site with RSVP, schedule, registry links, and accommodation info",
    category: "Starter Packs",
    icon: "Heart",
    projectKind: "web",
    isStarterPack: true,
    industry: "Wedding",
    seedPrompt:
      "Build a beautiful multi-page wedding website for a couple. HOME PAGE: Romantic hero with couple names and wedding date in elegant typography, a countdown timer to the wedding day, and a hero photo placeholder with a floral or watercolor overlay design. A 'Save the Date' section with location and date. Navigation to all pages. OUR STORY PAGE: Timeline of the couple's relationship milestones with photo placeholders, from 'How We Met' to 'The Proposal'. WEDDING DETAILS PAGE: Full ceremony schedule with time, location, address, map embed placeholder. Reception details, dress code, parking info, what to expect. RSVP PAGE: RSVP form with guest name, attendance confirmation, meal preference (Chicken/Fish/Vegetarian), dietary restrictions, plus-one info. Submission shows a heartfelt confirmation message. TRAVEL & STAY PAGE: Hotel accommodation blocks with discount code info, distance from venue, booking links. Local transportation tips, airport info. REGISTRY PAGE: Registry cards linking to 3 stores (Amazon, Crate & Barrel, Honeymoon Fund) with icon, store name, description. PHOTO GALLERY: Engagement photo grid placeholder, 12 image placeholders in a masonry layout. Design: romantic and elegant — soft colors (blush pink, sage green, ivory, or dusty blue), script font headings, floral decorative elements via CSS, generous white space.",
  },
  {
    id: "sp-event",
    title: "Event Registration",
    description:
      "Event site with agenda, speakers, ticket tiers, registration form, and sponsor showcase",
    category: "Starter Packs",
    icon: "CalendarCheck",
    projectKind: "web",
    isStarterPack: true,
    industry: "Events",
    seedPrompt:
      "Build a complete multi-page event registration website for a professional conference or meetup. HOME PAGE: Full-width hero with event name, tagline, date/location/format badges, and a 'Register Now' CTA with a live ticket count (e.g. '87 tickets remaining'). A countdown timer to the event. Speaker highlight section (3 featured speaker cards). Sponsor logo strip. SPEAKERS PAGE: Grid of 12 speaker cards with photo placeholder, name, company, talk title, and short bio. Clicking expands to a full bio modal with social links. AGENDA/SCHEDULE PAGE: Day-by-day schedule (2 days), each session showing time, title, speaker, room, and a track badge (Keynote, Workshop, Panel). Filter by track. TICKETS PAGE: 3 ticket tier cards (General $99, Professional $199, VIP $499) with feature comparison, early bird discount badge for lowest tier. Includes a simple registration form (name, email, company, dietary preferences, T-shirt size). VENUE PAGE: Venue name, address, photo placeholder, map embed, hotel recommendations, transit info, parking. SPONSORS PAGE: Sponsor grid organized by tier (Gold, Silver, Bronze, Media Partners) with logo placeholders and company descriptions. Design: bold and energizing — use a dark hero with vibrant accent color, professional conference aesthetic, strong typography hierarchy.",
  },
  {
    id: "sp-nonprofit",
    title: "Nonprofit & Charity",
    description:
      "Mission-driven nonprofit site with donation flow, impact stats, programs, and volunteer signup",
    category: "Starter Packs",
    icon: "Heart",
    projectKind: "web",
    isStarterPack: true,
    industry: "Nonprofit",
    seedPrompt:
      "Build a complete multi-page nonprofit organization website. HOME PAGE: Emotionally compelling hero with mission statement headline, a powerful photo placeholder, and two CTAs (Donate Now, Learn More). Impact stats bar (e.g. 12,000 Meals Served, 3,000 Families Helped, 15 Years of Service, 200 Volunteers). Program highlights section (3 program cards). Donation CTA banner with progress bar toward annual goal. Testimonial from a beneficiary. Partner logos strip. ABOUT PAGE: Organization story, founding history, team grid with photo placeholders, board of directors, annual report download button. VALUES/MISSION/VISION section. PROGRAMS PAGE: 3–4 program detail sections with description, who it serves, impact numbers, and a 'Support This Program' CTA. DONATE PAGE: Donation amount selector (preset amounts: $25, $50, $100, $250 + custom), monthly giving option with savings callout, tax-deductibility notice, impact equivalences ('Your $50 feeds a family for a week'), donor info form, and trust badges (Charity Navigator rating, SSL secure). VOLUNTEER PAGE: Volunteer opportunities grid with role, time commitment, skills needed, and 'Sign Up' button. Volunteer signup form. CONTACT PAGE: Office address, phone, email, contact form, social media links, newsletter signup. Design: warm, trustworthy, human — photography-forward with warm color palette (orange, teal, or deep green), emotional storytelling tone, accessible and inclusive.",
  },
];

export const TEMPLATES: TemplateDefinition[] = [
  ...STARTER_PACKS,
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
      "Build a sleek personal portfolio website. Start with a hero section that includes a professional greeting, a short bio paragraph, and links to GitHub and LinkedIn. Add a skills section displaying a grid of technology badges. Include a projects section showing 4 project cards with a title, description, tech stack tags, and GitHub/live demo links. Add a work experience timeline with 3 entries. Include a contact section with a simple form (name, email, message) and social links. Use smooth scroll navigation with a sticky header. Design should be minimal and elegant.",
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

  // ── Mobile templates ───────────────────────────────────────────────────────
  {
    id: "mobile-onboarding-auth",
    title: "Onboarding & Auth",
    description: "Expo app with animated onboarding slides, sign-in, and sign-up screens",
    category: "Mobile",
    icon: "Smartphone",
    projectKind: "mobile-cross",
    seedPrompt:
      "Build a complete Expo React Native onboarding and authentication app. Include 3 animated onboarding screens with illustrations (icon-based), title, subtitle, and a Next button with a progress indicator. The final onboarding screen has Get Started and Sign In buttons. Build a Sign Up screen with first name, last name, email, password, and confirm password fields, a terms of service checkbox, and a Create Account button. Build a Sign In screen with email, password, a Forgot Password link, and Sign In button. Include a Forgot Password screen with email input and Send Reset Link. Use Expo Router for navigation, NativeWind for styling, and a clean modern design with a primary brand color. Show smooth screen transition animations.",
  },
  {
    id: "mobile-social-feed",
    title: "Social Feed",
    description: "Expo social media app with feed, stories, post creation, and profile",
    category: "Mobile",
    icon: "Smartphone",
    projectKind: "mobile-cross",
    seedPrompt:
      "Build an Expo React Native social media app. Include a tab-based navigation with Home (feed), Search, Create Post, Notifications, and Profile tabs. The Home screen shows a horizontal stories strip at the top (avatar circles with ring indicators) followed by an infinite-scroll feed of posts (user avatar, name, caption, image placeholder, like/comment/share action bar). The Search screen has a search input and a grid of discovery content. The Create Post screen has an image picker area, caption input, and location tag. The Notifications screen lists recent likes, comments, and follows. The Profile screen shows avatar, bio, follower/following counts, a post grid, and a settings button. Use NativeWind for styling, Expo Router, and realistic mock data.",
  },
  {
    id: "mobile-ecommerce",
    title: "Mobile Store",
    description: "Expo e-commerce app with product catalog, cart, and checkout",
    category: "Mobile",
    icon: "ShoppingCart",
    projectKind: "mobile-cross",
    seedPrompt:
      "Build a full-featured Expo React Native e-commerce app. Include tab navigation: Home, Shop, Cart, Orders, and Profile. The Home screen has a banner carousel, category quick-picks (horizontal scroll), and featured products (FlatList). The Shop screen shows a searchable, filterable product grid with sort options. Each product card shows image placeholder, name, price, and rating. Product detail screen has image gallery, size/color selectors, description accordion, Add to Cart button, and related products. Cart screen shows items with quantity controls, remove button, subtotal, shipping estimate, and Checkout CTA. Checkout screen has address form, payment method selector, and order summary. Orders screen shows order history with status badges. Use NativeWind and Expo Router.",
  },
  {
    id: "mobile-dashboard",
    title: "Mobile Dashboard",
    description: "Expo analytics dashboard app with charts, stats, and data visualization",
    category: "Mobile",
    icon: "LayoutDashboard",
    projectKind: "mobile-cross",
    seedPrompt:
      "Build an Expo React Native analytics dashboard app. Include tab navigation: Overview, Reports, Transactions, and Settings. The Overview screen shows a greeting header with user name, 4 stat cards (Revenue, Users, Conversions, Churn) with trend arrows, a line chart for revenue over 30 days (use SVG or react-native-chart-kit placeholder comments), and a recent activity list. The Reports screen has a scrollable list of report cards with bar chart placeholders and date range filters. Transactions screen shows a searchable list of transactions with amount, merchant, date, and category badge. Settings screen has profile section, notifications toggles, appearance (dark/light), linked accounts, and sign out. Use NativeWind, Expo Router, and mock data throughout. Clean dark financial-app aesthetic.",
  },
  {
    id: "mobile-chat",
    title: "Chat Messenger",
    description: "Expo real-time chat app with conversations list, messages, and media sharing",
    category: "Mobile",
    icon: "Smartphone",
    projectKind: "mobile-cross",
    seedPrompt:
      "Build an Expo React Native chat messenger app. Include tab navigation: Chats, Calls, Status, and Profile. The Chats screen shows a searchable list of conversations with avatar, name, last message preview, timestamp, and unread count badge. Tapping a conversation opens the Chat screen with a message list (sent/received bubbles with timestamps), a typing indicator, and an input bar with text field, attachment icon, and send button. The message bubbles support text, image placeholder, and audio message placeholders. Include a New Chat button that opens a contact picker. Calls screen shows recent calls list with call type icon (audio/video), name, and duration. Status screen shows contacts' status updates with a ring around avatars. Profile shows avatar, name, bio, and privacy settings. Use NativeWind and Expo Router.",
  },
  {
    id: "mobile-subscription-saas",
    title: "Subscription SaaS",
    description: "Expo SaaS app with paywall, subscription plans, and gated premium content",
    category: "Mobile",
    icon: "CreditCard",
    projectKind: "mobile-cross",
    seedPrompt:
      "Build an Expo React Native subscription SaaS app. Include tab navigation: Home, Features, Account. The Home screen shows a hero with app value proposition, 3 feature preview cards (blurred/locked for non-subscribers), and a prominent Subscribe CTA button. The Features screen shows gated premium features (blurred overlays on locked items) with an upgrade prompt at the top for free users and full access for subscribers. Include a Paywall modal/screen with 3 plan cards (Monthly $9.99, Annual $79.99 with 'Best Value' badge, Lifetime $149.99), feature list with checkmarks, restore purchases link, and terms/privacy links. The Account screen shows subscription status badge (Free/Pro/Premium), billing info, manage subscription, and sign out. Include a Settings screen with notifications toggles, theme selector, and help. Use NativeWind, Expo Router, and mock subscription state.",
  },

  // ── Native feature templates ───────────────────────────────────────────────
  {
    id: "mobile-push-notifications",
    title: "Push Notifications",
    description:
      "Expo app with push notification opt-in, permission flow, and notification history",
    category: "Mobile",
    icon: "Bell",
    projectKind: "mobile-cross",
    seedPrompt:
      "Build a complete Expo React Native push notifications demo app using expo-notifications and expo-device. Include: (1) A Notifications Home screen with a permission banner — if notifications are not granted, show an 'Enable Notifications' card with a shield icon and a button that calls Notifications.requestPermissionsAsync(); if granted, show a green 'Notifications enabled' badge. (2) A notification history list (mock data: 5 past notifications with icon, title, body, and relative timestamp). (3) A 'Send Test' button that schedules a local notification in 3 seconds using Notifications.scheduleNotificationAsync(). (4) A Settings screen with a Notifications section: allow_alerts toggle, allow_badges toggle, allow_sounds toggle (all stored in AsyncStorage). (5) Show the push token in a copyable text field in Settings for debugging. Handle both foreground and background notification receipt: use a useNotifications() custom hook that sets up addNotificationReceivedListener and addNotificationResponseReceivedListener. For iOS/Android permission differences, show a platform-appropriate message if permission is denied. Use Expo Router for navigation, NativeWind for styling, and TypeScript throughout. Include app.json with the correct expo-notifications plugin config.",
  },
  {
    id: "mobile-deep-linking",
    title: "Deep Linking",
    description:
      "Expo app with universal links, shared link handling, and referral flows via Expo Router",
    category: "Mobile",
    icon: "Link",
    projectKind: "mobile-cross",
    seedPrompt:
      "Build an Expo React Native deep linking demo app using Expo Router v3 universal links and expo-linking. Include: (1) A Home screen that shows the last received deep link URL in a highlighted card (use Linking.getInitialURL() and Linking.addEventListener). (2) A 'Link Tester' screen with an input field where users can type a deep link path (e.g. /profile/123 or /invite?code=ABC) and a 'Simulate' button that calls router.push() with that path. (3) A Profile screen at app/(tabs)/profile/[id].tsx that reads useLocalSearchParams() to display a user profile card with id, name (mock), avatar placeholder, and a 'Invite a friend' button that calls Share.share() with a deep link URL. (4) An Invite screen at app/invite.tsx that reads a 'code' query param from the URL and shows a referral welcome card: 'You were invited with code [code]' with a Claim Reward button. (5) A Settings screen showing: scheme (from app.json), host, and a list of example deep link patterns with copy buttons. Configure app.json with scheme: 'myapp', intentFilters for Android, and associatedDomains for iOS (commented example). Use expo-constants for the app slug. Use NativeWind, Expo Router file-based routing, TypeScript, and include all required app.json config.",
  },
  {
    id: "mobile-iap-revenuecat",
    title: "In-App Purchases",
    description: "Expo app with RevenueCat paywall, subscription plans, and entitlement checks",
    category: "Mobile",
    icon: "ShoppingCart",
    projectKind: "mobile-cross",
    seedPrompt:
      "Build a complete Expo React Native in-app purchases app using the RevenueCat Purchases React Native SDK (@revenuecat/purchases-react-native). Include: (1) An initialization setup in app/_layout.tsx that calls Purchases.configure({ apiKey: process.env.EXPO_PUBLIC_REVENUECAT_API_KEY ?? '' }) on mount — fall back gracefully when the key is not set by showing a setup prompt instead of crashing. (2) A Paywall screen (app/paywall.tsx) that calls Purchases.getOfferings() and renders the 'default' offering's packages. Show 3 plan cards: Monthly, Annual (with 'Best Value' badge), and Lifetime — each with price from the StoreProduct, a feature checklist (5 items), and a 'Subscribe' button that calls Purchases.purchasePackage(). Handle PurchasesError codes: USER_CANCELLED silently, PRODUCT_ALREADY_PURCHASED shows 'Already subscribed', other errors show a toast. Include a 'Restore Purchases' button that calls Purchases.restorePurchases(). (3) A Home screen that calls Purchases.getCustomerInfo() and shows entitlement status: 'Pro' badge if 'pro_access' entitlement is active, or a 'Upgrade to Pro' button that opens the Paywall screen. (4) A subscription status card showing: plan name, renewal date (from CustomerInfo.activeSubscriptions), and a 'Manage Subscription' button that opens the platform store. (5) An Account screen with CustomerInfo details: userId, activeEntitlements list, and sign-out. Add EXPO_PUBLIC_REVENUECAT_API_KEY to a .env.example file with instructions. Use NativeWind, Expo Router, TypeScript, and include all required package.json dependencies. Note: RevenueCat requires a real device for production — the app should show a 'Simulated mode' banner in the web preview.",
  },
];

export const INDUSTRY_PERSONAS = [
  {
    id: "real-estate",
    label: "Real Estate Agent",
    templateId: "sp-real-estate",
    demoPrompt: "A property listing site for a local real estate agency",
  },
  {
    id: "restaurant",
    label: "Restaurant Owner",
    templateId: "sp-restaurant",
    demoPrompt: "An online menu and reservation system for a restaurant",
  },
  {
    id: "creator",
    label: "Portfolio Creator",
    templateId: "sp-portfolio-creator",
    demoPrompt: "A portfolio to showcase my design and photography work",
  },
  {
    id: "educator",
    label: "Online Educator",
    templateId: "sp-online-course",
    demoPrompt: "A landing page to sell my online course",
  },
  {
    id: "contractor",
    label: "Local Contractor",
    templateId: "sp-local-services",
    demoPrompt: "A website for my plumbing business with a quote form",
  },
  {
    id: "nonprofit",
    label: "Nonprofit Leader",
    templateId: "sp-nonprofit",
    demoPrompt: "A donation site for my charity organization",
  },
];

export const ONBOARDING_INDUSTRIES = [
  { id: "business", label: "Small Business", icon: "Briefcase", templateId: "sp-local-services" },
  {
    id: "restaurant",
    label: "Restaurant / Food",
    icon: "UtensilsCrossed",
    templateId: "sp-restaurant",
  },
  { id: "real-estate", label: "Real Estate", icon: "Building2", templateId: "sp-real-estate" },
  {
    id: "creator",
    label: "Creative / Portfolio",
    icon: "Palette",
    templateId: "sp-portfolio-creator",
  },
  {
    id: "education",
    label: "Education / Course",
    icon: "GraduationCap",
    templateId: "sp-online-course",
  },
  { id: "nonprofit", label: "Nonprofit / Charity", icon: "Heart", templateId: "sp-nonprofit" },
  { id: "event", label: "Event / Conference", icon: "CalendarCheck", templateId: "sp-event" },
  { id: "wedding", label: "Wedding / Personal", icon: "Heart", templateId: "sp-wedding" },
  { id: "saas", label: "SaaS / Tech", icon: "Zap", templateId: "saas-dashboard" },
  { id: "ecommerce", label: "Online Store", icon: "ShoppingCart", templateId: "ecommerce-store" },
  { id: "other", label: "Something Else", icon: "Sparkles", templateId: "landing-page" },
];
