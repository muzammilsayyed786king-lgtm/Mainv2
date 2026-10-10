import { timingSafeEqual } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
} from "discord.js";
import { and, eq } from "drizzle-orm";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  botExperienceBoostsTable,
  botVoteBoostsTable,
  botVoteSettingsTable,
  db,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { premiumColors } from "./presentation";

const VOTE_BOOST_DURATION_MS = 12 * 60 * 60 * 1000;
type VoteProvider = "topgg" | "discadia";

let voteClient: Client | undefined;

export function setVoteClient(client: Client): void {
  voteClient = client;
}

function voteAuthMatches(req: IncomingMessage, expected: string | undefined): boolean {
  if (!expected) return false;
  const authorization = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const provided = authorization ?? req.headers["x-webhook-secret"];
  if (typeof provided !== "string") return false;
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer);
}

function jsonResponse(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ message }));
}

async function readVotePayload(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalLength = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalLength += buffer.length;
    if (totalLength > 64 * 1024) throw new Error("Vote webhook payload exceeds 64 KiB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractVoterId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const candidates = [
    payload.user,
    payload.user_id,
    payload.userId,
    payload.discord_id,
    payload.discordId,
    isRecord(payload.data) ? payload.data.user : undefined,
    isRecord(payload.data) ? payload.data.user_id : undefined,
  ];
  for (const candidate of candidates) {
    const id = isRecord(candidate) ? candidate.id : candidate;
    if (typeof id === "string" && /^\d{17,20}$/.test(id)) return id;
  }
  return null;
}

function isTestVote(payload: unknown): boolean {
  return isRecord(payload) &&
    (payload.type === "test" || payload.event === "test" || payload.test === true);
}

async function configuredVoteServer(): Promise<typeof botVoteSettingsTable.$inferSelect | null> {
  const settings = await db.select().from(botVoteSettingsTable).limit(2);
  if (settings.length > 1) {
    throw new Error("More than one server has vote rewards configured");
  }
  return settings[0] ?? null;
}

async function rewardVote(
  guildId: string,
  userId: string,
  provider: VoteProvider,
): Promise<{ awarded: boolean; boostUntil: number }> {
  const now = Date.now();
  return db.transaction(async (tx) => {
    await tx
      .insert(botVoteBoostsTable)
      .values({ guildId, userId })
      .onConflictDoNothing();
    const [boost] = await tx
      .select()
      .from(botVoteBoostsTable)
      .where(and(
        eq(botVoteBoostsTable.guildId, guildId),
        eq(botVoteBoostsTable.userId, userId),
      ))
      .for("update");
    if (!boost) throw new Error("Could not load vote boost after insert");
    const lastVoteAt = provider === "topgg" ? boost.lastTopggVoteAt : boost.lastDiscadiaVoteAt;
    if (now - lastVoteAt < VOTE_BOOST_DURATION_MS) {
      return { awarded: false, boostUntil: boost.boostUntil };
    }

    await tx
      .update(botVoteBoostsTable)
      .set({
        boostUntil: Math.max(now, boost.boostUntil) + VOTE_BOOST_DURATION_MS,
        ...(provider === "topgg"
          ? { lastTopggVoteAt: now }
          : { lastDiscadiaVoteAt: now }),
        updatedAt: new Date(now),
      })
      .where(and(
        eq(botVoteBoostsTable.guildId, guildId),
        eq(botVoteBoostsTable.userId, userId),
      ));
    const [existingExperienceBoost] = await tx
      .select()
      .from(botExperienceBoostsTable)
      .where(and(
        eq(botExperienceBoostsTable.guildId, guildId),
        eq(botExperienceBoostsTable.userId, userId),
        eq(botExperienceBoostsTable.source, "vote"),
      ))
      .for("update");
    const experienceBoostUntil = Math.max(now, existingExperienceBoost?.expiresAt ?? 0) +
      VOTE_BOOST_DURATION_MS;
    await tx
      .insert(botExperienceBoostsTable)
      .values({
        guildId,
        userId,
        source: "vote",
        boostPercent: 20,
        expiresAt: experienceBoostUntil,
      })
      .onConflictDoUpdate({
        target: [
          botExperienceBoostsTable.guildId,
          botExperienceBoostsTable.userId,
          botExperienceBoostsTable.source,
        ],
        set: {
          boostPercent: 20,
          expiresAt: experienceBoostUntil,
          updatedAt: new Date(now),
        },
      });
    return {
      awarded: true,
      boostUntil: experienceBoostUntil,
    };
  });
}

export async function handleVoteWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  provider: VoteProvider,
): Promise<void> {
  const secretName = provider === "topgg" ? "TOPGG_WEBHOOK_AUTH" : "DISCADIA_WEBHOOK_AUTH";
  if (!process.env[secretName]) {
    logger.error({ provider }, "Vote webhook secret is not configured");
    jsonResponse(res, 503, "Vote webhook is not configured");
    return;
  }
  if (!voteAuthMatches(req, process.env[secretName])) {
    jsonResponse(res, 401, "Unauthorized");
    return;
  }

  let payload: unknown;
  try {
    payload = await readVotePayload(req);
  } catch (error) {
    logger.warn({ err: error, provider }, "Invalid vote webhook payload");
    jsonResponse(res, 400, "Invalid JSON payload");
    return;
  }
  if (isTestVote(payload)) {
    jsonResponse(res, 200, "Webhook test received");
    return;
  }
  const userId = extractVoterId(payload);
  if (!userId) {
    jsonResponse(res, 400, "Vote payload does not contain a valid Discord user ID");
    return;
  }

  try {
    const config = await configuredVoteServer();
    if (!config) {
      jsonResponse(res, 503, "No server has vote rewards configured");
      return;
    }
    const client = voteClient;
    if (!client) {
      jsonResponse(res, 503, "Discord bot is not ready");
      return;
    }
    const guild = await client.guilds.fetch(config.guildId).catch(() => null);
    const channel = await guild?.channels.fetch(config.channelId);
    if (!channel?.isSendable()) {
      throw new Error(`Vote announcement channel ${config.channelId} is unavailable`);
    }
    const member = await guild?.members.fetch(userId).catch(() => null);
    if (!member) {
      jsonResponse(res, 200, "Voter is not a member of the configured server");
      return;
    }
    const reward = await rewardVote(config.guildId, userId, provider);
    if (!reward.awarded) {
      jsonResponse(res, 200, "Vote already rewarded recently");
      return;
    }

    const providerLabel = provider === "topgg" ? "Top.gg" : "Discadia";
    const embed = new EmbedBuilder()
      .setColor(premiumColors.success)
      .setTitle("Thank you for voting!")
      .setDescription(
        `Thanks for voting for **${member.guild.name}** on **${providerLabel}**!`,
      )
      .addFields({
        name: "🎁 Rewards",
        value: "`-` **20% XP Boost** for **12 hours**\n" +
          `\`-\` Active until <t:${Math.floor(reward.boostUntil / 1000)}:R>`,
      })
      .setThumbnail(member.displayAvatarURL({ size: 128 }))
      .setTimestamp();
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setLabel("Discadia")
        .setStyle(ButtonStyle.Link)
        .setURL(config.discadiaUrl),
      new ButtonBuilder()
        .setLabel("Top.gg")
        .setStyle(ButtonStyle.Link)
        .setURL(config.topggUrl),
    );
    await channel.send({
      content: `<@${userId}>`,
      embeds: [embed],
      components: [buttons],
      allowedMentions: { users: [userId] },
    });
    logger.info(
      { guildId: config.guildId, userId, provider, boostUntil: reward.boostUntil },
      "Applied vote XP boost",
    );
    jsonResponse(res, 200, "Vote reward granted");
  } catch (error) {
    logger.error({ err: error, provider, userId }, "Could not process vote webhook");
    jsonResponse(res, 500, "Could not process vote");
  }
}
