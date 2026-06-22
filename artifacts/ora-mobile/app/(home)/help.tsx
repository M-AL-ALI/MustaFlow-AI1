import { useAuth } from "@clerk/expo";
import Constants from "expo-constants";
import {
  BookOpen,
  ChevronDown,
  LifeBuoy,
  MessageCircle,
  Search,
  Send,
  Ticket,
} from "lucide-react-native";
import React, { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Logo } from "@/components/Logo";
import { ScreenHeader } from "@/components/ScreenHeader";
import { SignInWall } from "@/components/SignInWall";
import { Button, Card, Loading } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import {
  escalateSupport,
  getSupportTicket,
  listHelpArticles,
  listSupportTickets,
  sendSupportChat,
} from "@/lib/api";
import type {
  HelpArticle,
  SupportMessage,
  SupportTicketDetail,
  SupportTicketSummary,
} from "@/lib/types";

type HelpTab = "articles" | "support" | "tickets";

const SUPPORT_CATEGORIES = ["general", "account", "billing", "bug", "mobile", "ora", "orax"];

function SectionTitle({ icon: Icon, title }: { icon: typeof BookOpen; title: string }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 }}>
      <Icon size={18} color={c.accentForeground} />
      <Text style={{ color: c.foreground, fontFamily: "Inter_700Bold", fontSize: 16 }}>
        {title}
      </Text>
    </View>
  );
}

function ArticleCard({ article }: { article: HelpArticle }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const tags = Array.isArray(article.tags) ? article.tags : [];

  return (
    <Card>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${open ? "Collapse" : "Expand"} ${article.title}`}
        onPress={() => setOpen((o) => !o)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 15 }}>
            {article.title}
          </Text>
          <Text style={{ color: c.mutedForeground, fontSize: 12 }}>{article.category}</Text>
        </View>
        <ChevronDown
          size={18}
          color={c.mutedForeground}
          style={{ transform: [{ rotate: open ? "180deg" : "0deg" }] }}
        />
      </Pressable>

      {open && (
        <View style={{ gap: 10, marginTop: 12 }}>
          <Text style={{ color: c.mutedForeground, fontSize: 14, lineHeight: 21 }}>
            {article.body}
          </Text>
          {tags.length > 0 && (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {tags.slice(0, 6).map((tag) => (
                <View
                  key={tag}
                  style={{
                    borderWidth: 1,
                    borderColor: c.border,
                    borderRadius: 999,
                    paddingHorizontal: 8,
                    paddingVertical: 3,
                  }}
                >
                  <Text style={{ color: c.mutedForeground, fontSize: 11 }}>{tag}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      )}
    </Card>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={{
        flex: 1,
        borderRadius: 999,
        paddingVertical: 10,
        alignItems: "center",
        backgroundColor: active ? c.foreground : "transparent",
      }}
    >
      <Text
        style={{
          color: active ? c.background : c.mutedForeground,
          fontFamily: "Inter_600SemiBold",
          fontSize: 13,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function SupportChat({ onTicketCreated }: { onTicketCreated: (ticketId: number) => void }) {
  const c = useColors();
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [input, setInput] = useState("");
  const [category, setCategory] = useState("general");
  const [sending, setSending] = useState(false);
  const [escalating, setEscalating] = useState(false);

  const canEscalate = messages.length > 0;

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    const next: SupportMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setSending(true);
    try {
      const res = await sendSupportChat({ message: text, messages, category });
      setMessages([...next, { role: "assistant", content: res.reply }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Support chat failed.";
      setMessages([...next, { role: "assistant", content: message }]);
    } finally {
      setSending(false);
    }
  }

  async function handleEscalate() {
    if (!canEscalate || escalating) return;
    const subject =
      messages.find((m) => m.role === "user")?.content.slice(0, 120) || "Ora mobile support";
    setEscalating(true);
    try {
      const res = await escalateSupport({
        subject,
        category,
        transcript: messages,
        deviceInfo: {
          appVersion: Constants.expoConfig?.version ?? null,
          buildNumber: Constants.expoConfig?.ios?.buildNumber ?? null,
          runtime: "ora-mobile",
        },
      });
      Alert.alert("Ticket created", `Support ticket #${res.ticketId} was created.`);
      onTicketCreated(res.ticketId);
    } catch (err) {
      Alert.alert("Could not create ticket", err instanceof Error ? err.message : "Try again.");
    } finally {
      setEscalating(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <Card style={{ gap: 10 }}>
        <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 15 }}>
          Report issue category
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {SUPPORT_CATEGORIES.map((item) => {
            const active = category === item;
            return (
              <Pressable
                key={item}
                onPress={() => setCategory(item)}
                style={{
                  borderRadius: 999,
                  borderWidth: 1,
                  borderColor: active ? c.accentForeground : c.border,
                  backgroundColor: active ? `${c.accentForeground}22` : c.card,
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                }}
              >
                <Text
                  style={{
                    color: active ? c.accentForeground : c.mutedForeground,
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 12,
                    textTransform: "capitalize",
                  }}
                >
                  {item}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Card>

      <Card style={{ minHeight: 260, gap: 12 }}>
        {messages.length === 0 ? (
          <View style={{ alignItems: "center", gap: 10, paddingVertical: 24 }}>
            <MessageCircle size={28} color={c.accentForeground} />
            <Text
              style={{
                color: c.foreground,
                fontFamily: "Inter_700Bold",
                fontSize: 16,
                textAlign: "center",
              }}
            >
              Ora Support Mode
            </Text>
            <Text
              style={{
                color: c.mutedForeground,
                fontSize: 14,
                lineHeight: 20,
                textAlign: "center",
              }}
            >
              Ask about using Ora, billing, account access, or a bug. This support chat is separate
              from your normal Ora conversations.
            </Text>
          </View>
        ) : (
          messages.map((m, index) => (
            <View
              key={`${m.role}-${index}`}
              style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "88%",
                borderRadius: 14,
                paddingHorizontal: 12,
                paddingVertical: 10,
                backgroundColor: m.role === "user" ? c.foreground : c.muted,
              }}
            >
              <Text
                style={{
                  color: m.role === "user" ? c.background : c.foreground,
                  fontSize: 14,
                  lineHeight: 20,
                }}
              >
                {m.content}
              </Text>
            </View>
          ))
        )}
        {sending && <Loading label="Ora Support is typing..." />}
      </Card>

      <View
        style={{
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c.card,
          borderRadius: 18,
          paddingHorizontal: 12,
          paddingVertical: 8,
          flexDirection: "row",
          alignItems: "flex-end",
          gap: 8,
        }}
      >
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Ask support or describe the issue..."
          placeholderTextColor={c.mutedForeground}
          multiline
          style={{
            flex: 1,
            color: c.foreground,
            maxHeight: 110,
            fontSize: 15,
            paddingVertical: 6,
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send support message"
          disabled={!input.trim() || sending}
          onPress={handleSend}
          style={{
            width: 38,
            height: 38,
            borderRadius: 19,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: input.trim() ? c.foreground : c.muted,
          }}
        >
          <Send size={18} color={input.trim() ? c.background : c.mutedForeground} />
        </Pressable>
      </View>

      <Button
        label="Escalate to support ticket"
        icon={Ticket}
        variant="secondary"
        disabled={!canEscalate}
        loading={escalating}
        onPress={handleEscalate}
        full
      />
    </View>
  );
}

function TicketsList({
  tickets,
  selected,
  onSelect,
}: {
  tickets: SupportTicketSummary[];
  selected: SupportTicketDetail | null;
  onSelect: (ticket: SupportTicketSummary) => void;
}) {
  const c = useColors();
  if (tickets.length === 0) {
    return (
      <Card style={{ alignItems: "center", gap: 8, paddingVertical: 24 }}>
        <Ticket size={28} color={c.mutedForeground} />
        <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold" }}>
          No support tickets yet
        </Text>
        <Text style={{ color: c.mutedForeground, textAlign: "center", lineHeight: 20 }}>
          Escalated support chats will appear here.
        </Text>
      </Card>
    );
  }

  return (
    <View style={{ gap: 10 }}>
      {tickets.map((ticket) => (
        <Pressable key={ticket.id} onPress={() => onSelect(ticket)}>
          <Card
            style={{
              gap: 6,
              borderColor: selected?.id === ticket.id ? c.accentForeground : c.border,
            }}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 10 }}>
              <Text
                style={{
                  color: c.foreground,
                  fontFamily: "Inter_600SemiBold",
                  fontSize: 15,
                  flex: 1,
                }}
                numberOfLines={2}
              >
                #{ticket.id} {ticket.subject}
              </Text>
              <Text style={{ color: c.accentForeground, fontFamily: "Inter_600SemiBold" }}>
                {ticket.status}
              </Text>
            </View>
            <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
              {ticket.category ?? "general"} - {new Date(ticket.createdAt).toLocaleString()}
            </Text>
          </Card>
        </Pressable>
      ))}

      {selected && (
        <Card style={{ gap: 10 }}>
          <Text style={{ color: c.foreground, fontFamily: "Inter_700Bold", fontSize: 16 }}>
            Ticket #{selected.id}
          </Text>
          <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
            Status: {selected.status} - Email: {selected.emailStatus ?? "pending"}
          </Text>
          {selected.transcript.length === 0 ? (
            <Text style={{ color: c.mutedForeground }}>No transcript attached.</Text>
          ) : (
            selected.transcript.map((m, index) => (
              <View key={`${selected.id}-${index}`} style={{ gap: 3 }}>
                <Text
                  style={{
                    color: c.foreground,
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 12,
                    textTransform: "capitalize",
                  }}
                >
                  {m.role}
                </Text>
                <Text style={{ color: c.mutedForeground, lineHeight: 20 }}>{m.content}</Text>
              </View>
            ))
          )}
        </Card>
      )}
    </View>
  );
}

export default function HelpScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { isSignedIn } = useAuth();
  const signedIn = !!isSignedIn;
  const [tab, setTab] = useState<HelpTab>("articles");
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [articles, setArticles] = useState<HelpArticle[]>([]);
  const [faqs, setFaqs] = useState<HelpArticle[]>([]);
  const [articlesLoading, setArticlesLoading] = useState(true);
  const [articleError, setArticleError] = useState<string | null>(null);
  const [tickets, setTickets] = useState<SupportTicketSummary[]>([]);
  const [ticketDetail, setTicketDetail] = useState<SupportTicketDetail | null>(null);
  const [ticketsLoading, setTicketsLoading] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => {
      setArticlesLoading(true);
      listHelpArticles(query, activeCategory ?? undefined)
        .then((data) => {
          setArticles(data.articles);
          setFaqs(data.faqs);
          setArticleError(null);
        })
        .catch((err) =>
          setArticleError(err instanceof Error ? err.message : "Could not load help."),
        )
        .finally(() => setArticlesLoading(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [query, activeCategory]);

  async function refreshTickets(selectId?: number) {
    if (!signedIn) return;
    setTicketsLoading(true);
    try {
      const list = await listSupportTickets();
      setTickets(list);
      const target = selectId ? list.find((t) => t.id === selectId) : list[0];
      if (target) {
        const detail = await getSupportTicket(target.id);
        setTicketDetail(detail);
      } else {
        setTicketDetail(null);
      }
    } catch (err) {
      Alert.alert("Could not load tickets", err instanceof Error ? err.message : "Try again.");
    } finally {
      setTicketsLoading(false);
    }
  }

  useEffect(() => {
    if (tab === "tickets" && signedIn) void refreshTickets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, signedIn]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    articles.forEach((a) => set.add(a.category));
    faqs.forEach((a) => set.add(a.category));
    return [...set].sort();
  }, [articles, faqs]);

  async function selectTicket(ticket: SupportTicketSummary) {
    setTicketsLoading(true);
    try {
      setTicketDetail(await getSupportTicket(ticket.id));
    } catch (err) {
      Alert.alert("Could not load ticket", err instanceof Error ? err.message : "Try again.");
    } finally {
      setTicketsLoading(false);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title="Help Center" subtitle="Articles, support chat, and tickets" />
      <ScrollView
        contentContainerStyle={{
          padding: 16,
          gap: 12,
          paddingBottom: insets.bottom + 24,
        }}
      >
        <Card style={{ alignItems: "center", gap: 10, paddingVertical: 22 }}>
          <Logo size={36} />
          <Text
            style={{
              color: c.mutedForeground,
              fontSize: 14,
              textAlign: "center",
              lineHeight: 20,
              maxWidth: 320,
            }}
          >
            Browse Ora help articles, talk with Ora Support, escalate issues, and track your tickets
            without touching AI Builder surfaces.
          </Text>
        </Card>

        <View
          accessibilityRole="tablist"
          style={{
            flexDirection: "row",
            padding: 4,
            borderRadius: 999,
            backgroundColor: c.muted,
            gap: 4,
          }}
        >
          <TabButton
            label="Articles"
            active={tab === "articles"}
            onPress={() => setTab("articles")}
          />
          <TabButton label="Support" active={tab === "support"} onPress={() => setTab("support")} />
          <TabButton label="Tickets" active={tab === "tickets"} onPress={() => setTab("tickets")} />
        </View>

        {tab === "articles" && (
          <View style={{ gap: 12 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                borderRadius: 14,
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: c.card,
                paddingHorizontal: 12,
              }}
            >
              <Search size={18} color={c.mutedForeground} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search articles and FAQs..."
                placeholderTextColor={c.mutedForeground}
                style={{ flex: 1, color: c.foreground, paddingVertical: 12 }}
              />
            </View>

            {categories.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Pressable
                    onPress={() => setActiveCategory(null)}
                    style={{
                      borderWidth: 1,
                      borderColor: activeCategory == null ? c.accentForeground : c.border,
                      backgroundColor: activeCategory == null ? `${c.accentForeground}22` : c.card,
                      borderRadius: 999,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                    }}
                  >
                    <Text
                      style={{
                        color: activeCategory == null ? c.accentForeground : c.mutedForeground,
                        fontFamily: "Inter_600SemiBold",
                        fontSize: 12,
                      }}
                    >
                      All
                    </Text>
                  </Pressable>
                  {categories.map((category) => (
                    <Pressable
                      key={category}
                      onPress={() => setActiveCategory(category)}
                      style={{
                        borderWidth: 1,
                        borderColor: activeCategory === category ? c.accentForeground : c.border,
                        backgroundColor:
                          activeCategory === category ? `${c.accentForeground}22` : c.card,
                        borderRadius: 999,
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                      }}
                    >
                      <Text
                        style={{
                          color:
                            activeCategory === category ? c.accentForeground : c.mutedForeground,
                          fontFamily: "Inter_600SemiBold",
                          fontSize: 12,
                        }}
                      >
                        {category}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
            )}

            {articlesLoading ? (
              <Loading label="Loading help articles..." />
            ) : articleError ? (
              <Card>
                <Text style={{ color: c.destructive }}>{articleError}</Text>
              </Card>
            ) : (
              <>
                <SectionTitle icon={BookOpen} title="Articles" />
                {articles.length === 0 ? (
                  <Card>
                    <Text style={{ color: c.mutedForeground }}>No articles found.</Text>
                  </Card>
                ) : (
                  articles.map((a) => <ArticleCard key={`article-${a.id}`} article={a} />)
                )}
                <SectionTitle icon={LifeBuoy} title="FAQs" />
                {faqs.length === 0 ? (
                  <Card>
                    <Text style={{ color: c.mutedForeground }}>No FAQs found.</Text>
                  </Card>
                ) : (
                  faqs.map((a) => <ArticleCard key={`faq-${a.id}`} article={a} />)
                )}
              </>
            )}
          </View>
        )}

        {tab === "support" &&
          (signedIn ? (
            <SupportChat
              onTicketCreated={(ticketId) => {
                setTab("tickets");
                void refreshTickets(ticketId);
              }}
            />
          ) : (
            <SignInWall
              title="Sign in for Ora Support"
              description="Help articles are public, but support chat and tickets are private to your account."
            />
          ))}

        {tab === "tickets" &&
          (signedIn ? (
            ticketsLoading ? (
              <Loading label="Loading support tickets..." />
            ) : (
              <TicketsList tickets={tickets} selected={ticketDetail} onSelect={selectTicket} />
            )
          ) : (
            <SignInWall
              title="Sign in to view tickets"
              description="Your support tickets are owner-scoped and only visible after sign-in."
            />
          ))}
      </ScrollView>
    </View>
  );
}
