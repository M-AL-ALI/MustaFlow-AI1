import { useAuth, useUser } from "@clerk/expo";
import { setAuthState, setAuthTokenGetter } from "@/lib/auth-client";
import { clearAllStoredDocumentRefs } from "@/lib/document-refs-store";
import { DrawerContentScrollView, DrawerContentComponentProps } from "@react-navigation/drawer";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { Drawer } from "expo-router/drawer";
import {
  BookOpen,
  Brain,
  Bug,
  Camera,
  Clock,
  FolderOpen,
  HelpCircle,
  LifeBuoy,
  LogIn,
  LogOut,
  MessageSquare,
  Plus,
  Settings,
  TerminalSquare,
} from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ActiveProjectProvider } from "@/context/ActiveProjectContext";
import { useActiveProject } from "@/context/ActiveProjectContext";
import { useColors } from "@/hooks/useColors";
import { createProject, getOraUsage, listConversations, listProjects } from "@/lib/api";
import type { OraConversationSummary, OraProjectSummary, OraUsage } from "@/lib/types";

const mustaflowLogo = require("@/assets/mustaflow-logo.png");

function formatResetsIn(resetsAt: string): string {
  const diff = new Date(resetsAt).getTime() - Date.now();
  if (diff <= 0) return "soon";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

type Colors = ReturnType<typeof useColors>;

function SectionHeader({ label, onPlus, c }: { label: string; onPlus?: () => void; c: Colors }) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingHorizontal: 14,
        paddingVertical: 5,
      }}
    >
      <Text
        style={{
          color: c.mutedForeground,
          fontSize: 11,
          fontFamily: "Inter_600SemiBold",
          letterSpacing: 0.6,
        }}
      >
        {label}
      </Text>
      {onPlus && (
        <Pressable onPress={onPlus} hitSlop={10}>
          <Plus size={15} color={c.mutedForeground} />
        </Pressable>
      )}
    </View>
  );
}

function ConvRow({
  conv,
  onPress,
  c,
}: {
  conv: OraConversationSummary;
  onPress: () => void;
  c: Colors;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: c.radius,
      }}
    >
      <MessageSquare size={14} color={c.mutedForeground} />
      <Text
        numberOfLines={1}
        style={{ flex: 1, color: c.foreground, fontSize: 14, fontFamily: "Inter_400Regular" }}
      >
        {conv.title || "Untitled"}
      </Text>
    </Pressable>
  );
}

function ProjRow({
  project,
  onPress,
  c,
}: {
  project: OraProjectSummary;
  onPress: () => void;
  c: Colors;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderRadius: c.radius,
      }}
    >
      <FolderOpen size={14} color={c.mutedForeground} />
      <View style={{ flex: 1 }}>
        <Text
          numberOfLines={1}
          style={{ color: c.foreground, fontSize: 14, fontFamily: "Inter_500Medium" }}
        >
          {project.name}
        </Text>
        {!!project.description && (
          <Text numberOfLines={1} style={{ color: c.mutedForeground, fontSize: 12 }}>
            {project.description}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

function NavItem({
  label,
  icon: Icon,
  active,
  onPress,
  c,
}: {
  label: string;
  icon: React.ComponentType<{ size: number; color: string }>;
  active: boolean;
  onPress: () => void;
  c: Colors;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 11,
        paddingHorizontal: 14,
        borderRadius: c.radius,
        backgroundColor: active ? c.accent : "transparent",
      }}
    >
      <Icon size={19} color={active ? c.accentForeground : c.mutedForeground} />
      <Text
        style={{
          color: active ? c.foreground : c.mutedForeground,
          fontFamily: active ? "Inter_600SemiBold" : "Inter_500Medium",
          fontSize: 15,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function NewProjectModal({
  visible,
  onClose,
  onCreated,
  c,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (project: OraProjectSummary) => void;
  c: Colors;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const project = await createProject(name.trim(), desc.trim() || undefined);
      setName("");
      setDesc("");
      onCreated(project);
    } catch {
      // silent — server errors leave the modal open for retry
    } finally {
      setCreating(false);
    }
  }, [name, desc, creating, onCreated]);

  const handleClose = useCallback(() => {
    setName("");
    setDesc("");
    onClose();
  }, [onClose]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)" }} onPress={handleClose} />
        <View
          style={{
            backgroundColor: c.background,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            padding: 24,
            paddingBottom: 40,
            gap: 20,
          }}
        >
          {/* Title row */}
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            <View
              style={{
                width: 42,
                height: 42,
                borderRadius: 10,
                backgroundColor: c.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <FolderOpen size={20} color={c.accentForeground} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.foreground, fontFamily: "Inter_700Bold", fontSize: 18 }}>
                New project
              </Text>
              <Text style={{ color: c.mutedForeground, fontSize: 13, marginTop: 2 }}>
                Group related conversations together. Give your project a name and, optionally, a
                short description.
              </Text>
            </View>
          </View>

          {/* Project name */}
          <View style={{ gap: 6 }}>
            <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>
              Project name
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="e.g. Marketing plan"
              placeholderTextColor={c.mutedForeground}
              returnKeyType="next"
              autoFocus
              style={{
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: c.radius,
                paddingHorizontal: 14,
                paddingVertical: 12,
                color: c.foreground,
                fontFamily: "Inter_400Regular",
                fontSize: 15,
                backgroundColor: c.background,
              }}
            />
          </View>

          {/* Description */}
          <View style={{ gap: 6 }}>
            <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>
              Description{" "}
              <Text style={{ color: c.mutedForeground, fontFamily: "Inter_400Regular" }}>
                (optional)
              </Text>
            </Text>
            <TextInput
              value={desc}
              onChangeText={(t) => setDesc(t.slice(0, 500))}
              placeholder="What is this project about?"
              placeholderTextColor={c.mutedForeground}
              multiline
              numberOfLines={4}
              style={{
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: c.radius,
                paddingHorizontal: 14,
                paddingVertical: 12,
                color: c.foreground,
                fontFamily: "Inter_400Regular",
                fontSize: 15,
                backgroundColor: c.background,
                height: 100,
                textAlignVertical: "top",
              }}
            />
            <Text
              style={{
                color: c.mutedForeground,
                fontSize: 12,
                textAlign: "right",
              }}
            >
              {desc.length}/500
            </Text>
          </View>

          {/* Buttons */}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 12, marginTop: 4 }}>
            <Pressable onPress={handleClose} style={{ paddingVertical: 12, paddingHorizontal: 20 }}>
              <Text
                style={{
                  color: c.mutedForeground,
                  fontFamily: "Inter_500Medium",
                  fontSize: 15,
                }}
              >
                Cancel
              </Text>
            </Pressable>
            <Pressable
              onPress={handleCreate}
              disabled={!name.trim() || creating}
              style={{
                paddingVertical: 12,
                paddingHorizontal: 24,
                borderRadius: c.radius,
                backgroundColor: name.trim() && !creating ? c.primary : c.muted,
                alignItems: "center",
                justifyContent: "center",
                minWidth: 130,
              }}
            >
              {creating ? (
                <ActivityIndicator size="small" color={c.primaryForeground} />
              ) : (
                <Text
                  style={{
                    color: c.primaryForeground,
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 15,
                  }}
                >
                  Create project
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function CustomDrawer(props: DrawerContentComponentProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { signOut, isSignedIn } = useAuth();
  const { user } = useUser();
  const router = useRouter();
  const { setActiveProjectId, setPendingConversationId, triggerNewConversation } =
    useActiveProject();

  const [conversations, setConversations] = useState<OraConversationSummary[]>([]);
  const [projects, setProjects] = useState<OraProjectSummary[]>([]);
  const [usage, setUsage] = useState<OraUsage | null>(null);
  const [showNewProject, setShowNewProject] = useState(false);

  const refresh = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const [convs, projs, u] = await Promise.all([
        listConversations(),
        listProjects(),
        getOraUsage(),
      ]);
      setConversations(convs.slice(0, 8));
      setProjects(projs);
      setUsage(u);
    } catch {
      // silent — drawer data is best-effort
    }
  }, [isSignedIn]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav = props.navigation as any;
    if (typeof nav.addListener === "function") {
      const unsub = nav.addListener("drawerOpen", refresh);
      return () => {
        unsub();
      };
    }
  }, [props.navigation, refresh]);

  const activeRoute = props.state.routeNames[props.state.index];

  const goToChat = useCallback(() => {
    props.navigation.navigate("index");
  }, [props.navigation]);

  const handleNewConversation = useCallback(() => {
    setActiveProjectId(null);
    triggerNewConversation();
    goToChat();
  }, [setActiveProjectId, triggerNewConversation, goToChat]);

  const handleConversationSelect = useCallback(
    (id: number) => {
      setPendingConversationId(id);
      goToChat();
    },
    [setPendingConversationId, goToChat],
  );

  const handleProjectSelect = useCallback(
    (project: OraProjectSummary) => {
      setActiveProjectId(project.id);
      triggerNewConversation();
      goToChat();
    },
    [setActiveProjectId, triggerNewConversation, goToChat],
  );

  const handleProjectCreated = useCallback(
    (project: OraProjectSummary) => {
      setProjects((prev) => [project, ...prev]);
      setShowNewProject(false);
      setActiveProjectId(project.id);
      triggerNewConversation();
      goToChat();
    },
    [setActiveProjectId, triggerNewConversation, goToChat],
  );

  const signedInNavItems: {
    name: string;
    label: string;
    icon: React.ComponentType<{ size: number; color: string }>;
    tab?: string;
  }[] = [
    { name: "orax", label: "Orax", icon: TerminalSquare },
    { name: "memory", label: "Memory", icon: Brain },
    { name: "library", label: "Library", icon: BookOpen },
    { name: "help", label: "Help Center", icon: HelpCircle, tab: "articles" },
    { name: "help", label: "Report Issue", icon: Bug, tab: "support" },
    { name: "help", label: "My Support Tickets", icon: LifeBuoy, tab: "tickets" },
    { name: "settings", label: "Settings", icon: Settings },
  ];

  const anonNavItems: {
    name: string;
    label: string;
    icon: React.ComponentType<{ size: number; color: string }>;
    tab?: string;
  }[] = [
    { name: "settings", label: "Settings", icon: Settings },
    { name: "help", label: "Help", icon: HelpCircle, tab: "articles" },
  ];

  const navItems = isSignedIn ? signedInNavItems : anonNavItems;

  const msgsLeft = usage ? Math.max(0, usage.messageLimit - usage.messageCount) : null;
  const imgsLeft = usage ? Math.max(0, usage.imageLimit - usage.imageCount) : null;

  const initials = (
    user?.firstName?.[0] ??
    user?.username?.[0] ??
    user?.primaryEmailAddress?.emailAddress?.[0] ??
    "U"
  ).toUpperCase();

  return (
    <View style={{ flex: 1, backgroundColor: c.sidebar }}>
      <DrawerContentScrollView
        {...props}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 8 }}
      >
        {/* ── Logo / header ── */}
        <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View
              style={{
                borderRadius: 12,
                borderWidth: 1,
                borderColor: c.sidebarBorder,
                backgroundColor: c.sidebarAccent,
                padding: 8,
                shadowColor: "#000",
                shadowOpacity: 0.12,
                shadowRadius: 4,
                shadowOffset: { width: 0, height: 2 },
                elevation: 2,
              }}
            >
              <Image
                source={mustaflowLogo}
                style={{ width: 26, height: 32 }}
                contentFit="contain"
                transition={150}
              />
            </View>
            <Text style={{ color: c.foreground, fontFamily: "Inter_700Bold", fontSize: 16 }}>
              Ora
            </Text>
          </View>
        </View>

        {/* ── New conversation button ── */}
        <View style={{ paddingHorizontal: 10, paddingBottom: 10 }}>
          <Pressable
            onPress={handleNewConversation}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              paddingVertical: 12,
              borderRadius: c.radius,
              backgroundColor: c.primary,
            }}
          >
            <Plus size={16} color={c.primaryForeground} />
            <Text
              style={{
                color: c.primaryForeground,
                fontFamily: "Inter_600SemiBold",
                fontSize: 15,
              }}
            >
              New conversation
            </Text>
          </Pressable>
        </View>

        {isSignedIn && (
          <>
            {/* ── Recent conversations ── */}
            <View style={{ paddingHorizontal: 6, marginTop: 2 }}>
              <SectionHeader label="RECENT CONVERSATIONS" onPlus={handleNewConversation} c={c} />
              {conversations.length === 0 ? (
                <Text
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 6,
                    color: c.mutedForeground,
                    fontSize: 13,
                  }}
                >
                  No recent conversations
                </Text>
              ) : (
                conversations.map((conv) => (
                  <ConvRow
                    key={conv.id}
                    conv={conv}
                    onPress={() => handleConversationSelect(conv.id)}
                    c={c}
                  />
                ))
              )}
            </View>

            {/* ── Projects ── */}
            <View style={{ paddingHorizontal: 6, marginTop: 10 }}>
              <SectionHeader label="PROJECTS" onPlus={() => setShowNewProject(true)} c={c} />
              {projects.map((project) => (
                <ProjRow
                  key={project.id}
                  project={project}
                  onPress={() => handleProjectSelect(project)}
                  c={c}
                />
              ))}
            </View>
          </>
        )}

        {/* ── Divider ── */}
        <View
          style={{
            height: 1,
            backgroundColor: c.border,
            marginHorizontal: 16,
            marginTop: 14,
            marginBottom: 6,
          }}
        />

        {/* ── Nav items ── */}
        <View style={{ paddingHorizontal: 6 }}>
          {navItems.map((item, i) => (
            <NavItem
              key={`${item.name}-${i}`}
              label={item.label}
              icon={item.icon}
              active={
                item.name === activeRoute &&
                item.label !== "Report Issue" &&
                item.label !== "My Support Tickets"
              }
              onPress={() => {
                if (item.tab) {
                  router.push({
                    pathname: `/(home)/${item.name}`,
                    params: { tab: item.tab },
                  } as never);
                } else {
                  props.navigation.navigate(item.name);
                }
              }}
              c={c}
            />
          ))}
        </View>
      </DrawerContentScrollView>

      {/* ── Usage stats ── */}
      {isSignedIn && usage !== null && (
        <View
          style={{
            marginHorizontal: 12,
            marginBottom: 8,
            borderRadius: c.radius,
            backgroundColor: c.muted,
            padding: 12,
            gap: 5,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <MessageSquare size={12} color={c.mutedForeground} />
            <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
              {msgsLeft} of {usage.messageLimit} messages left
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Camera size={12} color={c.mutedForeground} />
            <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
              {imgsLeft} of {usage.imageLimit} images left
            </Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Clock size={12} color={c.mutedForeground} />
            <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
              Resets in {formatResetsIn(usage.resetsAt)}
            </Text>
          </View>
        </View>
      )}

      {/* ── User section ── */}
      <View
        style={{
          borderTopWidth: 1,
          borderTopColor: c.border,
          padding: 16,
          paddingBottom: insets.bottom + 16,
          gap: 10,
        }}
      >
        {isSignedIn ? (
          <>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <View
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: 17,
                  backgroundColor: c.primary,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text
                  style={{
                    color: c.primaryForeground,
                    fontFamily: "Inter_700Bold",
                    fontSize: 14,
                  }}
                >
                  {initials}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  numberOfLines={1}
                  style={{
                    color: c.foreground,
                    fontFamily: "Inter_600SemiBold",
                    fontSize: 14,
                  }}
                >
                  {user?.fullName || user?.username || "Signed in"}
                </Text>
                <Text numberOfLines={1} style={{ color: c.mutedForeground, fontSize: 12 }}>
                  {user?.primaryEmailAddress?.emailAddress ?? ""}
                </Text>
              </View>
            </View>
            <Pressable
              onPress={async () => {
                // Device-global cache hygiene: drop cached upload refs so the
                // next signed-in user never inherits them.
                clearAllStoredDocumentRefs();
                await signOut();
                router.replace("/sign-in");
              }}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: 6,
              }}
            >
              <LogOut size={16} color={c.destructive} />
              <Text
                style={{
                  color: c.destructive,
                  fontFamily: "Inter_500Medium",
                  fontSize: 14,
                }}
              >
                Sign out
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 18 }}>
              Sign in to unlock Memory, Library, and Orax.
            </Text>
            <Pressable
              onPress={() => router.push("/sign-in")}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 10,
                paddingVertical: 6,
              }}
            >
              <LogIn size={16} color={c.primary} />
              <Text
                style={{
                  color: c.primary,
                  fontFamily: "Inter_600SemiBold",
                  fontSize: 14,
                }}
              >
                Sign in
              </Text>
            </Pressable>
          </>
        )}
      </View>

      <NewProjectModal
        visible={showNewProject}
        onClose={() => setShowNewProject(false)}
        onCreated={handleProjectCreated}
        c={c}
      />
    </View>
  );
}

export default function HomeLayout() {
  const c = useColors();
  const { isLoaded, isSignedIn, getToken } = useAuth();

  useEffect(() => {
    setAuthState(isLoaded, isSignedIn ?? false);
  }, [isLoaded, isSignedIn]);

  useEffect(() => {
    setAuthTokenGetter(async () => {
      try {
        return (await getToken()) ?? null;
      } catch {
        return null;
      }
    });
  }, [getToken]);

  if (!isLoaded) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: c.background,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator color={c.primary} />
      </View>
    );
  }

  return (
    <ActiveProjectProvider>
      <Drawer
        drawerContent={(props) => <CustomDrawer {...props} />}
        screenOptions={{
          headerShown: false,
          drawerType: "front",
          swipeEdgeWidth: 60,
          sceneStyle: { backgroundColor: c.background },
        }}
      >
        <Drawer.Screen name="index" />
        <Drawer.Screen name="orax" />
        <Drawer.Screen name="memory" />
        <Drawer.Screen name="library" />
        <Drawer.Screen name="settings" />
        <Drawer.Screen name="help" />
      </Drawer>
    </ActiveProjectProvider>
  );
}
