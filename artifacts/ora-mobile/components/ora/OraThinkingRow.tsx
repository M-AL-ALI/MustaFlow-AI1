import { useEffect } from "react";
import { View, Text } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { OraAtom } from "@/components/ora/OraAtom";
import { useColors } from "@/hooks/useColors";
import type { OraActivityPhase, OraActivityTool } from "@/lib/types";

/**
 * OraThinkingRow — native mirror of the website Ora loading indicator
 * (artifacts/mustaflow/src/components/ora-panel.tsx, the `isLoading &&
 * !isStreamingWithContent` block).
 *
 * The website does NOT render a blank assistant bubble while waiting for the
 * first token. Instead it shows a separate left-aligned row: the atom avatar,
 * three pulsing accent dots (staggered 0/200/400ms, accent at 50% alpha), and an
 * optional status label ("Thinking…", "Replying…", etc.).
 *
 * When an `activity` step is provided (the live activity trace — web search,
 * file generation, image generation, repo analysis, file reading, dataset
 * analysis), its label
 * replaces the plain status label with a fade-in/fade-out lifecycle: each step
 * fades in as it starts, fades out when the next begins (keyed remount), and a
 * failed step shows briefly in a muted destructive tint. Wording arrives via
 * the shared @workspace/ora-contracts copy map — identical to the website.
 */

/** The current activity-trace step rendered by the row (client-keyed). */
export interface OraActivityRowStep {
  /** Client-assigned identity so a NEW step remounts (fade out old, fade in new). */
  id: number;
  tool: OraActivityTool;
  text: string;
  phase: OraActivityPhase;
}

function ThinkingDot({ accentColor, delay }: { accentColor: string; delay: number }) {
  const opacity = useSharedValue(0.3);

  useEffect(() => {
    opacity.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration: 600, easing: Easing.inOut(Easing.ease) }), -1, true),
    );
  }, [delay, opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      style={[{ width: 6, height: 6, borderRadius: 3, backgroundColor: accentColor + "80" }, style]}
    />
  );
}

export function OraThinkingRow({
  accentColor,
  label,
  activity,
}: {
  accentColor: string;
  label?: string;
  activity?: OraActivityRowStep | null;
}) {
  const c = useColors();
  // Failed steps get the same muted red the chat uses for retry affordances;
  // everything else stays in the subtle muted-foreground voice.
  const activityColor = activity?.phase === "fail" ? "#f87171" : c.mutedForeground;

  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10 }}>
      <OraAtom size={24} accentColor={accentColor} animated style={{ marginTop: 2 }} />
      <View style={{ gap: 4, paddingTop: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <ThinkingDot accentColor={accentColor} delay={0} />
          <ThinkingDot accentColor={accentColor} delay={200} />
          <ThinkingDot accentColor={accentColor} delay={400} />
        </View>
        {activity ? (
          <Animated.Text
            // Keyed by step identity + phase: a new step (or an in-place
            // ok/fail update) remounts, so the old label fades out while the
            // new one fades in — the same living-trace feel as the website.
            key={`${activity.id}:${activity.phase}`}
            entering={FadeIn.duration(220)}
            exiting={FadeOut.duration(180)}
            style={{ color: activityColor, fontSize: 11, fontFamily: "Inter_500Medium" }}
          >
            {activity.text}
          </Animated.Text>
        ) : (
          !!label && (
            <Text style={{ color: c.mutedForeground, fontSize: 11, fontFamily: "Inter_500Medium" }}>
              {label}
            </Text>
          )
        )}
      </View>
    </View>
  );
}
