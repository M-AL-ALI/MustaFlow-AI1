/**
 * Migration: create plan_templates table and seed system plan templates.
 * Run: pnpm --filter @workspace/scripts run migrate-plan-templates
 */
import { pool } from "@workspace/db";

const SYSTEM_TEMPLATES = [
  {
    slug: "saas-dashboard",
    category: "SaaS",
    name: "SaaS Dashboard",
    description: "A multi-page SaaS admin dashboard with analytics, user management, and settings.",
    sort_order: 1,
    plan: {
      summary: "A full-featured SaaS admin dashboard with analytics overview, user management, billing, and account settings.",
      goal: "Build a professional SaaS admin dashboard that lets users monitor key metrics, manage team members, and configure their account.",
      approach: "Multi-page React SPA with a fixed sidebar navigation, responsive grid layouts for metrics cards, and data tables for user management.",
      sitemap: [
        { name: "Dashboard", route: "/", purpose: "Analytics overview with KPI cards, charts, and recent activity feed" },
        { name: "Users", route: "/users", purpose: "Searchable, sortable table of team members with role management" },
        { name: "Billing", route: "/billing", purpose: "Subscription plan, payment history, and upgrade prompts" },
        { name: "Settings", route: "/settings", purpose: "Account preferences, notifications, and integrations" },
      ],
      pages: ["Dashboard", "Users", "Billing", "Settings"],
      backend: ["REST API for user CRUD", "Subscription status endpoint", "Analytics aggregation"],
      database: ["users table", "subscriptions table", "activity_logs table"],
      dataModel: [
        { table: "users", fields: ["id", "name", "email", "role", "created_at", "last_active"] },
        { table: "subscriptions", fields: ["id", "user_id", "plan", "status", "current_period_end"] },
      ],
      integrations: ["Stripe (billing)", "Analytics provider"],
      keysNeeded: ["STRIPE_PUBLISHABLE_KEY"],
      complexityScore: 7,
      recommendedMode: "power",
      estimatedBuildSeconds: 60,
      risks: ["Stripe webhook reliability", "Real-time data staleness"],
      testPlan: ["All nav links work", "User table search filters correctly", "Billing page loads plan details"],
      uxNotes: {
        "Dashboard": "Dark sidebar, metric cards with trend arrows, sparkline charts. Dense but readable.",
        "Users": "Sticky table header, inline role dropdown, pagination at the bottom.",
        "Billing": "Current plan highlighted, payment history in a clean timeline.",
        "Settings": "Grouped form sections with save-per-section pattern.",
      },
      accessibilityNotes: "Keyboard-navigable sidebar, ARIA roles on data tables, color-blind-safe chart palette.",
    },
  },
  {
    slug: "marketing-site",
    category: "Marketing",
    name: "Marketing / Landing Page",
    description: "A high-conversion marketing site with hero, features, pricing, and CTA sections.",
    sort_order: 2,
    plan: {
      summary: "A polished marketing website with a hero, feature highlights, social proof, pricing table, and a clear call-to-action.",
      goal: "Create a conversion-focused marketing site that clearly communicates the product's value and drives sign-ups.",
      approach: "Single-page layout with smooth scroll sections, animated hero, and a sticky nav bar. Mobile-first responsive design.",
      sitemap: [
        { name: "Home", route: "/", purpose: "Hero + features + testimonials + pricing + footer CTA" },
        { name: "Blog", route: "/blog", purpose: "Article list for SEO and thought leadership" },
      ],
      pages: ["Home", "Blog"],
      backend: [],
      database: [],
      dataModel: [],
      integrations: [],
      keysNeeded: [],
      complexityScore: 3,
      recommendedMode: "eco",
      estimatedBuildSeconds: 25,
      risks: ["Copy and messaging are placeholders — replace before launch"],
      testPlan: ["Hero CTA scrolls to pricing", "All sections visible on mobile", "Nav links jump to sections"],
      uxNotes: {
        "Home": "Bold headline above the fold, subtle gradient background, animated feature cards, 3-tier pricing table.",
        "Blog": "Card grid with featured image, title, and excerpt. Simple and fast.",
      },
      accessibilityNotes: "Semantic heading hierarchy (h1→h2→h3), alt text on all images, keyboard-visible focus rings.",
    },
  },
  {
    slug: "ecommerce-store",
    category: "E-commerce",
    name: "E-commerce Store",
    description: "A full online store with product catalog, cart, checkout, and order history.",
    sort_order: 3,
    plan: {
      summary: "An online store with a product catalog, shopping cart, Stripe checkout, and order confirmation.",
      goal: "Build a complete e-commerce storefront that lets customers browse products, add them to cart, and pay securely.",
      approach: "Multi-page app with product grid, detail pages, persistent cart via localStorage, and Stripe Payment Links for checkout.",
      sitemap: [
        { name: "Catalog", route: "/", purpose: "Filterable product grid with search and category tabs" },
        { name: "Product Detail", route: "/products/:id", purpose: "Full product info, images, reviews, and Add to Cart" },
        { name: "Cart", route: "/cart", purpose: "Line items, quantity control, order summary, checkout button" },
        { name: "Order Confirmation", route: "/order/:id", purpose: "Success page after payment with order summary" },
      ],
      pages: ["Catalog", "Product Detail", "Cart", "Order Confirmation"],
      backend: ["Product API", "Stripe checkout session creation"],
      database: ["products table", "orders table"],
      dataModel: [
        { table: "products", fields: ["id", "name", "description", "price", "image_url", "category", "stock"] },
        { table: "orders", fields: ["id", "stripe_session_id", "items", "total", "status", "created_at"] },
      ],
      integrations: ["Stripe (payments)"],
      keysNeeded: ["STRIPE_PUBLISHABLE_KEY", "STRIPE_SECRET_KEY"],
      complexityScore: 6,
      recommendedMode: "power",
      estimatedBuildSeconds: 50,
      risks: ["Stripe webhook for order status", "Inventory concurrency", "Image CDN needed for real products"],
      testPlan: ["Add product to cart", "Cart totals update correctly", "Checkout redirects to Stripe"],
      uxNotes: {
        "Catalog": "Responsive product grid (2 col mobile, 3-4 col desktop), price badge, hover zoom on cards.",
        "Product Detail": "Large hero image with thumbnail strip, sticky add-to-cart panel on desktop.",
        "Cart": "Slide-in drawer on mobile, full page on desktop. Running total always visible.",
        "Order Confirmation": "Celebratory layout, order ID prominently shown, email confirmation note.",
      },
      accessibilityNotes: "Product images must have descriptive alt text, cart quantity inputs have aria-labels, form fields are labelled.",
    },
  },
  {
    slug: "blog-cms",
    category: "Content",
    name: "Blog / Content Site",
    description: "A blog with article listing, full post view, categories, and author profiles.",
    sort_order: 4,
    plan: {
      summary: "A clean blog with an article feed, full post view, category filtering, and author bio pages.",
      goal: "Build a readable, SEO-friendly blog that presents articles clearly and makes it easy for readers to explore content by topic.",
      approach: "Multi-page layout with a featured article hero, card grid for recent posts, single-article template with typography optimised for reading, and a sidebar with categories and related posts.",
      sitemap: [
        { name: "Home", route: "/", purpose: "Featured article hero + recent posts grid" },
        { name: "Post", route: "/posts/:slug", purpose: "Full article with hero image, rich text body, and related posts" },
        { name: "Category", route: "/categories/:slug", purpose: "All posts in a given category" },
        { name: "About", route: "/about", purpose: "Team or author bios" },
      ],
      pages: ["Home", "Post", "Category", "About"],
      backend: [],
      database: ["posts table", "categories table", "authors table"],
      dataModel: [
        { table: "posts", fields: ["id", "title", "slug", "excerpt", "body", "category_id", "author_id", "published_at"] },
        { table: "categories", fields: ["id", "name", "slug"] },
      ],
      integrations: [],
      keysNeeded: [],
      complexityScore: 4,
      recommendedMode: "eco",
      estimatedBuildSeconds: 30,
      risks: ["Sample posts are placeholder — replace with real content before launch"],
      testPlan: ["Posts list loads", "Clicking a post shows full content", "Category filter shows correct posts"],
      uxNotes: {
        "Home": "Large hero with featured article, 3-column grid below, clean sans-serif typography.",
        "Post": "Max-width prose container (65ch), generous line height, drop-cap on first paragraph.",
        "Category": "Simple list view with article count badge in the header.",
        "About": "Card grid of authors with avatar, title, and short bio.",
      },
      accessibilityNotes: "Article headings use correct hierarchy, images have alt text, links have descriptive text (not 'click here').",
    },
  },
  {
    slug: "internal-admin-tool",
    category: "Internal Tools",
    name: "Internal Admin Tool",
    description: "An internal operations dashboard for managing data, running bulk actions, and viewing reports.",
    sort_order: 5,
    plan: {
      summary: "An internal admin tool with searchable data tables, bulk action support, a reporting dashboard, and an audit log.",
      goal: "Give operations teams a powerful interface for managing records, running bulk updates, and viewing activity.",
      approach: "Data-dense multi-tab layout with sortable/filterable tables, modal-based edit forms, bulk select with action toolbar, and CSV export.",
      sitemap: [
        { name: "Records", route: "/", purpose: "Searchable sortable table of primary records with bulk action bar" },
        { name: "Reports", route: "/reports", purpose: "Summary stats, date-range charts, and KPI tiles" },
        { name: "Audit Log", route: "/audit", purpose: "Chronological log of all admin actions with user attribution" },
        { name: "Settings", route: "/settings", purpose: "Admin configuration, user roles, and API keys" },
      ],
      pages: ["Records", "Reports", "Audit Log", "Settings"],
      backend: ["CRUD API", "Bulk update endpoint", "CSV export endpoint"],
      database: ["records table", "audit_logs table", "admin_users table"],
      dataModel: [
        { table: "records", fields: ["id", "name", "status", "tags", "created_at", "updated_at"] },
        { table: "audit_logs", fields: ["id", "admin_user_id", "action", "resource_id", "diff", "created_at"] },
      ],
      integrations: [],
      keysNeeded: [],
      complexityScore: 6,
      recommendedMode: "power",
      estimatedBuildSeconds: 55,
      risks: ["Bulk actions need confirmation dialog to prevent accidents", "Audit log can grow large — add pagination"],
      testPlan: ["Search filters records correctly", "Bulk select + delete works", "CSV export downloads file"],
      uxNotes: {
        "Records": "Dense table with sticky header, checkbox column, inline status badges, action column with edit/delete.",
        "Reports": "Date range picker in toolbar, bar chart for trends, summary metric tiles at the top.",
        "Audit Log": "Timeline with actor avatar, action verb, resource link, and timestamp.",
        "Settings": "Accordion-style grouped settings, save button per group.",
      },
      accessibilityNotes: "Table checkboxes have aria-labels, action buttons have tooltips, modal dialogs trap focus.",
    },
  },
  {
    slug: "project-management",
    category: "Productivity",
    name: "Project Management Tool",
    description: "A kanban-style project tracker with boards, tasks, assignees, and due dates.",
    sort_order: 6,
    plan: {
      summary: "A kanban project tracker with drag-and-drop boards, task cards, assignee management, and deadline tracking.",
      goal: "Help teams visualise and manage work with a clear kanban board, detailed task views, and progress reports.",
      approach: "Board view as default with column-per-status layout, draggable task cards, a detail slide-over panel, and a list view toggle for power users.",
      sitemap: [
        { name: "Board", route: "/", purpose: "Kanban board with drag-and-drop task cards across status columns" },
        { name: "Task Detail", route: "/tasks/:id", purpose: "Full task view: description, comments, attachments, activity" },
        { name: "Members", route: "/members", purpose: "Team roster and workload overview" },
        { name: "Timeline", route: "/timeline", purpose: "Gantt-style view of tasks by due date" },
      ],
      pages: ["Board", "Task Detail", "Members", "Timeline"],
      backend: ["Task CRUD API", "Drag-and-drop reorder endpoint"],
      database: ["tasks table", "members table", "comments table"],
      dataModel: [
        { table: "tasks", fields: ["id", "title", "description", "status", "assignee_id", "priority", "due_date"] },
        { table: "members", fields: ["id", "name", "email", "role", "avatar_url"] },
        { table: "comments", fields: ["id", "task_id", "author_id", "body", "created_at"] },
      ],
      integrations: [],
      keysNeeded: [],
      complexityScore: 7,
      recommendedMode: "power",
      estimatedBuildSeconds: 65,
      risks: ["Drag-and-drop requires careful touch support testing", "Concurrent edits may conflict — optimistic UI needed"],
      testPlan: ["Cards can be dragged between columns", "Task detail opens and saves", "Due date overdue highlighting works"],
      uxNotes: {
        "Board": "3-4 status columns, card shows title + assignee avatar + priority badge. Add-card button at column bottom.",
        "Task Detail": "Slide-over panel or full-page. Rich text description, status dropdown, date picker, comment thread.",
        "Members": "Avatar grid with workload bar per member (tasks assigned vs. capacity).",
        "Timeline": "Simple Gantt bars by week. Overdue items highlighted in red.",
      },
      accessibilityNotes: "Drag-and-drop has keyboard alternative (move-up/down buttons), focus management on slide-over open/close.",
    },
  },
  {
    slug: "booking-system",
    category: "Services",
    name: "Booking & Appointment System",
    description: "An appointment booking tool with availability calendar, time slot selection, and confirmation flow.",
    sort_order: 7,
    plan: {
      summary: "An appointment booking system with a calendar availability view, time-slot picker, booking form, and confirmation email.",
      goal: "Let customers book appointments or services online without back-and-forth scheduling, with instant confirmation.",
      approach: "Public-facing booking flow (calendar → time slot → details form → confirmation) and an admin view to manage bookings and availability.",
      sitemap: [
        { name: "Book", route: "/", purpose: "Month calendar showing available days; click a day to see time slots" },
        { name: "Confirm", route: "/confirm", purpose: "Customer details form + booking summary + pay/confirm button" },
        { name: "Success", route: "/success", purpose: "Booking confirmed page with reference number and calendar add link" },
        { name: "Admin", route: "/admin", purpose: "View all upcoming bookings, block dates, and manage availability" },
      ],
      pages: ["Book", "Confirm", "Success", "Admin"],
      backend: ["Availability API", "Booking creation endpoint", "Email notification trigger"],
      database: ["bookings table", "availability_blocks table"],
      dataModel: [
        { table: "bookings", fields: ["id", "customer_name", "customer_email", "service", "start_time", "end_time", "status"] },
        { table: "availability_blocks", fields: ["id", "date", "start_time", "end_time", "is_blocked"] },
      ],
      integrations: ["Email (confirmation)", "Calendar (ICS export)"],
      keysNeeded: [],
      complexityScore: 6,
      recommendedMode: "power",
      estimatedBuildSeconds: 50,
      risks: ["Race conditions on slot selection — need optimistic locking", "Timezone handling is tricky"],
      testPlan: ["Selecting an available slot moves to confirm page", "Form submits and shows success page", "Admin can block a date"],
      uxNotes: {
        "Book": "Clean monthly calendar, available days in primary colour, unavailable greyed out. Time slots in a scrollable list.",
        "Confirm": "Two-column: left = booking summary; right = customer form. Progress bar at the top.",
        "Success": "Large checkmark, reference number, 'Add to calendar' and 'Share' buttons.",
        "Admin": "Table of upcoming bookings, date-range filter, block-dates modal.",
      },
      accessibilityNotes: "Calendar days are buttons with aria-label including the date and availability, form fields are labelled, success page uses role='status'.",
    },
  },
  {
    slug: "portfolio-site",
    category: "Personal",
    name: "Personal Portfolio",
    description: "A personal portfolio site showcasing work, skills, and a contact form.",
    sort_order: 8,
    plan: {
      summary: "A clean personal portfolio with a hero, skills section, project showcase, and contact form.",
      goal: "Present work and skills in a professional, memorable way that impresses potential clients or employers.",
      approach: "Single-page design with smooth scroll sections. Hero with a brief intro, filterable project cards, a skill grid, and a working contact form.",
      sitemap: [
        { name: "Home", route: "/", purpose: "Hero intro with name, tagline, and primary CTA (view work / contact)" },
        { name: "Projects", route: "/projects", purpose: "Filterable grid of portfolio projects with tech stack tags" },
        { name: "About", route: "/about", purpose: "Extended bio, skills, experience timeline" },
        { name: "Contact", route: "/contact", purpose: "Contact form with email, phone, and social links" },
      ],
      pages: ["Home", "Projects", "About", "Contact"],
      backend: ["Contact form email sender"],
      database: [],
      dataModel: [],
      integrations: ["Email (Resend or Formspree for contact form)"],
      keysNeeded: [],
      complexityScore: 3,
      recommendedMode: "eco",
      estimatedBuildSeconds: 25,
      risks: ["Contact form needs a real email service to send (placeholder will show success state)"],
      testPlan: ["All nav links work", "Project filter tabs show correct items", "Contact form shows success state"],
      uxNotes: {
        "Home": "Full-viewport hero with subtle background texture, animated text reveal, professional photo or avatar.",
        "Projects": "3-column card grid with screenshot thumbnail, project title, tech tags, and View button.",
        "About": "Two-column: left = bio prose; right = skill badges and experience timeline.",
        "Contact": "Centred form, social icon row below, subtle map or location note.",
      },
      accessibilityNotes: "Color contrast meets AA standard, all images have alt text, form labels are associated with inputs.",
    },
  },
  {
    slug: "ai-tool-webapp",
    category: "AI",
    name: "AI-Powered Tool",
    description: "A web app that wraps an AI model to provide a specific task-focused user experience.",
    sort_order: 9,
    plan: {
      summary: "An AI-powered web app with an input form, model call, streaming response display, and history of past runs.",
      goal: "Let users submit a task or prompt, see the AI output in a clean UI, and review their past results.",
      approach: "Single-page app with a prominent input area (textarea + options), live streaming output panel, and a sidebar with past sessions.",
      sitemap: [
        { name: "App", route: "/", purpose: "Main interface: input form + live output display + options sidebar" },
        { name: "History", route: "/history", purpose: "List of past inputs and outputs with copy and re-run buttons" },
        { name: "Settings", route: "/settings", purpose: "API key configuration, model selection, and output preferences" },
      ],
      pages: ["App", "History", "Settings"],
      backend: ["AI proxy endpoint (streams response to client)", "Session storage API"],
      database: ["sessions table (input, output, model, created_at)"],
      dataModel: [
        { table: "sessions", fields: ["id", "user_id", "input", "output", "model", "tokens_used", "created_at"] },
      ],
      integrations: ["OpenAI (or Anthropic)"],
      keysNeeded: ["OPENAI_API_KEY"],
      complexityScore: 5,
      recommendedMode: "power",
      estimatedBuildSeconds: 45,
      risks: ["Streaming requires SSE or WebSocket — fallback to polling if needed", "Token costs can escalate — add usage display"],
      testPlan: ["Submit a prompt and see output", "Output streams or appears fully", "History list shows past sessions"],
      uxNotes: {
        "App": "Split-pane layout: input left/top, output right/bottom. Animated loading indicator during generation. Copy button on output.",
        "History": "Reverse-chronological list with input preview, model badge, and re-run button.",
        "Settings": "Simple form for API key (masked), model dropdown, temperature slider.",
      },
      accessibilityNotes: "Streaming output updates use aria-live='polite' so screen readers announce completions, form fields labelled.",
    },
  },
  {
    slug: "social-community",
    category: "Social",
    name: "Community / Social Feed",
    description: "A social community platform with a post feed, user profiles, likes, and comments.",
    sort_order: 10,
    plan: {
      summary: "A social community platform with a chronological feed, user profiles, post creation, likes, and comments.",
      goal: "Build an engaged community space where members can share posts, react to content, and interact through comments.",
      approach: "Feed-first design with a prominent create-post composer, infinite-scroll timeline, like/comment interactions, and user profile pages.",
      sitemap: [
        { name: "Feed", route: "/", purpose: "Reverse-chronological post feed with like and comment interactions" },
        { name: "Create Post", route: "/create", purpose: "Rich post composer with text, image upload, and tags" },
        { name: "Profile", route: "/profile/:username", purpose: "User's posts, followers/following counts, and bio" },
        { name: "Post Detail", route: "/posts/:id", purpose: "Full post with threaded comments" },
      ],
      pages: ["Feed", "Create Post", "Profile", "Post Detail"],
      backend: ["Post CRUD API", "Like/unlike endpoint", "Comment API", "User profile API"],
      database: ["posts table", "users table", "likes table", "comments table", "follows table"],
      dataModel: [
        { table: "posts", fields: ["id", "author_id", "body", "image_url", "tags", "like_count", "created_at"] },
        { table: "comments", fields: ["id", "post_id", "author_id", "body", "created_at"] },
        { table: "likes", fields: ["id", "post_id", "user_id"] },
      ],
      integrations: [],
      keysNeeded: [],
      complexityScore: 7,
      recommendedMode: "power",
      estimatedBuildSeconds: 70,
      risks: ["Real-time updates need polling or WebSocket", "Image uploads need storage (use placeholder images initially)", "Moderation not included"],
      testPlan: ["Feed loads posts", "Like button toggles", "Comment submits and appears", "Profile shows user's posts"],
      uxNotes: {
        "Feed": "Card-based posts with avatar, name, timestamp, body, image, and action bar (like / comment / share).",
        "Create Post": "Full-page composer with character count, tag picker, and image preview.",
        "Profile": "Cover photo + avatar + stats bar (posts / followers / following) + posts grid.",
        "Post Detail": "Full post body at top, comment thread below with nested replies.",
      },
      accessibilityNotes: "Like buttons have aria-pressed state, images have alt text, infinite scroll has a 'Load more' fallback button.",
    },
  },
];

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS plan_templates (
        id serial PRIMARY KEY,
        slug text NOT NULL UNIQUE,
        category text NOT NULL,
        name text NOT NULL,
        description text NOT NULL,
        platform text NOT NULL DEFAULT 'web',
        plan jsonb NOT NULL,
        is_system boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS plan_templates_category_idx ON plan_templates(category)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS plan_templates_sort_order_idx ON plan_templates(sort_order)`,
    );

    for (const tpl of SYSTEM_TEMPLATES) {
      await client.query(
        `INSERT INTO plan_templates (slug, category, name, description, plan, is_system, sort_order)
         VALUES ($1, $2, $3, $4, $5::jsonb, true, $6)
         ON CONFLICT (slug) DO UPDATE
           SET category = EXCLUDED.category,
               name = EXCLUDED.name,
               description = EXCLUDED.description,
               plan = EXCLUDED.plan,
               sort_order = EXCLUDED.sort_order`,
        [tpl.slug, tpl.category, tpl.name, tpl.description, JSON.stringify(tpl.plan), tpl.sort_order],
      );
    }

    await client.query("COMMIT");
    console.log(`plan_templates migration complete — ${SYSTEM_TEMPLATES.length} templates upserted.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
