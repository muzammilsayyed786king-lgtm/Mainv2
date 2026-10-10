import {
  ActionRowBuilder,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type GuildMember,
  type Message,
  type MessageCreateOptions,
  type VoiceState,
} from "discord.js";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  botExperiencePreferencesTable,
  botExperienceBoostsTable,
  botExperienceSettingsTable,
  botExperienceTable,
  botLevelRolesTable,
  botMiningProfilesTable,
  db,
} from "@workspace/db";
import { logger } from "../lib/logger";
import { premiumColors } from "./presentation";
import { reactToLevelUpMessage } from "./automation";

const XP_PER_LEVEL = 100;
const CHAT_XP_COOLDOWN_MS = 60_000;
const VOICE_XP_INTERVAL_MS = 60_000;
const MIN_CHAT_XP = 15;
const MAX_CHAT_XP = 25;
const CHAT_CREDIT_REWARD = 20;
const VOICE_XP = 10;

interface AwardResult {
  amount: number;
  totalXp: number;
  level: number;
  levelsGained: number;
}

type LevelUpSender = (payload: MessageCreateOptions) => Promise<Message>;

interface ExperienceSettings {
  levelUpChannelId: string | null;
  embedTitle: string | null;
  embedDescription: string | null;
  embedColor: string | null;
  allowedChatChannelIds: string[];
}

const DEFAULT_LEVEL_UP_TITLE = "🎉 New Level Gained!";
const DEFAULT_LEVEL_UP_DESCRIPTION =
  "✨ {user} leveled up **{levels_gained}** to **Level {level}**!";
const DEFAULT_LEVEL_UP_COLOR = premiumColors.success;
const chatCooldowns = new Map<string, number>();
const chatChannelAllowlistCache = new Map<string, { channelIds: string[]; expiresAt: number }>();
const voiceJoinedAt = new Map<string, number>();
let voiceXpTimer: NodeJS.Timeout | undefined;
let voiceXpTickRunning = false;
const CHAT_CHANNEL_ALLOWLIST_CACHE_TTL_MS = 60_000;

function profileKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

async function awardXp(
  guildId: string,
  userId: string,
  amount: number,
  activity: "chat" | "voice",
): Promise<AwardResult | null> {
  const now = Date.now();
  return db.transaction(async (tx) => {
    await tx
      .insert(botExperienceTable)
      .values({ guildId, userId })
      .onConflictDoNothing();

    const [profile] = await tx
      .select()
      .from(botExperienceTable)
      .where(and(
        eq(botExperienceTable.guildId, guildId),
        eq(botExperienceTable.userId, userId),
      ))
      .for("update");
    if (!profile) throw new Error("Could not load experience profile after insert");

    const lastAwardAt = activity === "chat" ? profile.lastChatXpAt : profile.lastVoiceXpAt;
    const cooldown = activity === "chat" ? CHAT_XP_COOLDOWN_MS : VOICE_XP_INTERVAL_MS;
    if (now - lastAwardAt < cooldown) return null;

    const activeBoosts = await tx
      .select({ boostPercent: botExperienceBoostsTable.boostPercent })
      .from(botExperienceBoostsTable)
      .where(and(
        eq(botExperienceBoostsTable.guildId, guildId),
        eq(botExperienceBoostsTable.userId, userId),
        gte(botExperienceBoostsTable.expiresAt, now + 1),
      ));
    const totalBoostPercent = activeBoosts.reduce((total, boost) => total + boost.boostPercent, 0);
    const awardedAmount = Math.ceil(amount * (100 + totalBoostPercent) / 100);
    const totalXp = profile.totalXp + awardedAmount;
    const level = Math.floor(totalXp / XP_PER_LEVEL) + 1;
    await tx
      .update(botExperienceTable)
      .set({
        totalXp,
        level,
        ...(activity === "chat" ? { lastChatXpAt: now } : { lastVoiceXpAt: now }),
        updatedAt: new Date(now),
      })
      .where(and(
        eq(botExperienceTable.guildId, guildId),
        eq(botExperienceTable.userId, userId),
      ));

    if (activity === "chat") {
      await tx
        .insert(botMiningProfilesTable)
        .values({ guildId, userId, coins: CHAT_CREDIT_REWARD })
        .onConflictDoUpdate({
          target: [botMiningProfilesTable.guildId, botMiningProfilesTable.userId],
          set: {
            coins: sql<number>`${botMiningProfilesTable.coins} + ${CHAT_CREDIT_REWARD}`,
            updatedAt: new Date(now),
          },
        });
    }

    return {
      amount: awardedAmount,
      totalXp,
      level,
      levelsGained: level - profile.level,
    };
  });
}

async function getExperienceSettings(guildId: string): Promise<ExperienceSettings> {
  const [settings] = await db
    .select()
    .from(botExperienceSettingsTable)
    .where(eq(botExperienceSettingsTable.guildId, guildId));
  return {
    levelUpChannelId: settings?.levelUpChannelId ?? null,
    embedTitle: settings?.embedTitle ?? null,
    embedDescription: settings?.embedDescription ?? null,
    embedColor: settings?.embedColor ?? null,
    allowedChatChannelIds: settings?.allowedChatChannelIds ?? [],
  };
}

async function getAllowedChatChannelIds(guildId: string): Promise<string[]> {
  const now = Date.now();
  const cached = chatChannelAllowlistCache.get(guildId);
  if (cached && cached.expiresAt > now) return cached.channelIds;

  const [settings] = await db
    .select({ channelIds: botExperienceSettingsTable.allowedChatChannelIds })
    .from(botExperienceSettingsTable)
    .where(eq(botExperienceSettingsTable.guildId, guildId));
  const channelIds = settings?.channelIds ?? [];
  chatChannelAllowlistCache.set(guildId, {
    channelIds,
    expiresAt: now + CHAT_CHANNEL_ALLOWLIST_CACHE_TTL_MS,
  });
  return channelIds;
}

function interpolateTemplate(
  template: string,
  member: GuildMember,
  result: AwardResult,
): string {
  const progress = result.totalXp % XP_PER_LEVEL;
  const values: Record<string, string> = {
    user: `<@${member.id}>`,
    username: member.displayName,
    level: String(result.level),
    levels_gained: String(result.levelsGained),
    xp: String(result.amount),
    total_xp: String(result.totalXp),
    progress: String(progress),
    next_level_xp: String(XP_PER_LEVEL - progress),
  };
  return template.replace(/\{([a-z_]+)\}/gi, (placeholder, key: string) =>
    values[key.toLowerCase()] ?? placeholder,
  );
}

function buildLevelUpEmbed(
  member: GuildMember,
  result: AwardResult,
  settings: ExperienceSettings,
): EmbedBuilder {
  const progress = result.totalXp % XP_PER_LEVEL;
  const filled = Math.floor((progress / XP_PER_LEVEL) * 10);
  const meter = `${"▰".repeat(filled)}${"▱".repeat(10 - filled)}`;
  const title = interpolateTemplate(
    settings.embedTitle ?? DEFAULT_LEVEL_UP_TITLE,
    member,
    result,
  );
  const description = interpolateTemplate(
    settings.embedDescription ?? DEFAULT_LEVEL_UP_DESCRIPTION,
    member,
    result,
  );
  const color = settings.embedColor
    ? Number.parseInt(settings.embedColor.slice(1), 16)
    : DEFAULT_LEVEL_UP_COLOR;

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .addFields(
      {
        name: "🌟 XP Earned",
        value: `**+${result.amount} XP** • ${result.totalXp.toLocaleString()} XP total`,
        inline: true,
      },
      {
        name: "📈 Next Level",
        value: `${progress}/${XP_PER_LEVEL} XP\n${meter}`,
        inline: true,
      },
    )
    .setThumbnail(member.displayAvatarURL({ size: 128 }))
    .setFooter({ text: "Stay active in chat and voice to keep earning XP." })
    .setTimestamp();
}

async function announceLevelUp(
  defaultSend: LevelUpSender,
  guildId: string,
  member: GuildMember,
  result: AwardResult,
): Promise<void> {
  if (result.levelsGained < 1) return;
  await awardLevelRoles(member, result);
  const settings = await getExperienceSettings(guildId);
  const [preferences] = await db
    .select()
    .from(botExperiencePreferencesTable)
    .where(and(
      eq(botExperiencePreferencesTable.guildId, guildId),
      eq(botExperiencePreferencesTable.userId, member.id),
    ));
  if ((preferences?.serverNotifications ?? true) === false && !preferences?.dmNotifications) return;

  let send = defaultSend;
  if (preferences?.serverNotifications && settings.levelUpChannelId) {
    const channel = await member.guild.channels.fetch(settings.levelUpChannelId);
    if (!channel || !channel.isSendable()) {
      throw new Error(`Configured level-up channel ${settings.levelUpChannelId} is unavailable`);
    }
    send = (payload) => channel.send(payload);
  }
  const embed = buildLevelUpEmbed(member, result, settings);
  if (preferences?.serverNotifications ?? true) {
    const levelUpMessage = await send({
      embeds: [embed],
      allowedMentions: { users: [member.id] },
    });
    await reactToLevelUpMessage(levelUpMessage);
  }
  if (preferences?.dmNotifications) {
    await member.send({
      embeds: [embed],
      allowedMentions: { parse: [] },
    }).catch((error: unknown) => {
      logger.warn(
        { err: error, guildId, userId: member.id },
        "Could not send level-up notification by DM",
      );
    });
  }
}

async function awardLevelRoles(member: GuildMember, result: AwardResult): Promise<void> {
  const firstNewLevel = result.level - result.levelsGained + 1;
  let mappings: (typeof botLevelRolesTable.$inferSelect)[];
  try {
    mappings = await db
      .select()
      .from(botLevelRolesTable)
      .where(and(
        eq(botLevelRolesTable.guildId, member.guild.id),
        gte(botLevelRolesTable.level, firstNewLevel),
        lte(botLevelRolesTable.level, result.level),
      ));
  } catch (error) {
    logger.error(
      { err: error, guildId: member.guild.id, userId: member.id },
      "Failed to load configured level roles",
    );
    return;
  }
  if (mappings.length === 0) return;

  const guildMember = member.guild.members.me;
  if (!guildMember?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    logger.error(
      { guildId: member.guild.id, userId: member.id },
      "Cannot grant configured level roles: bot is missing Manage Roles permission",
    );
    return;
  }

  for (const mapping of mappings) {
    const role = await member.guild.roles.fetch(mapping.roleId);
    if (!role) {
      logger.error(
        { guildId: member.guild.id, userId: member.id, level: mapping.level, roleId: mapping.roleId },
        "Configured level role no longer exists",
      );
      continue;
    }
    if (role.managed || guildMember.roles.highest.comparePositionTo(role) <= 0) {
      logger.error(
        { guildId: member.guild.id, userId: member.id, level: mapping.level, roleId: role.id },
        "Cannot grant configured level role because it is managed or above the bot",
      );
      continue;
    }
    if (member.roles.cache.has(role.id)) continue;
    try {
      await member.roles.add(role, `Reached level ${mapping.level}`);
    } catch (error) {
      logger.error(
        { err: error, guildId: member.guild.id, userId: member.id, level: mapping.level, roleId: role.id },
        "Failed to grant configured level role",
      );
    }
  }
}

export async function awardChatXp(message: Message): Promise<void> {
  if (
    !message.guild ||
    message.author.bot ||
    !message.content.trim() ||
    message.content.trim().startsWith("!")
  ) return;

  const allowedChannelIds = await getAllowedChatChannelIds(message.guild.id);
  if (allowedChannelIds.length > 0 && !allowedChannelIds.includes(message.channel.id)) return;

  const key = profileKey(message.guild.id, message.author.id);
  const now = Date.now();
  if (now - (chatCooldowns.get(key) ?? 0) < CHAT_XP_COOLDOWN_MS) return;

  const amount = MIN_CHAT_XP + Math.floor(Math.random() * (MAX_CHAT_XP - MIN_CHAT_XP + 1));
  const result = await awardXp(message.guild.id, message.author.id, amount, "chat");
  if (!result) return;
  chatCooldowns.set(key, now);

  const member = message.member ?? await message.guild.members.fetch(message.author.id);
  const channel = message.channel;
  if (channel.isSendable()) {
    await announceLevelUp((payload) => channel.send(payload), message.guild.id, member, result);
  } else if (result.levelsGained > 0) {
    logger.warn(
      { guildId: message.guild.id, channelId: channel.id, userId: member.id },
      "Cannot send level-up announcement in this channel",
    );
  }
}

function voiceEligible(member: GuildMember): boolean {
  const channel = member.voice.channel;
  if (!channel || channel.type !== ChannelType.GuildVoice) return false;
  if (member.guild.afkChannelId === channel.id) return false;
  if (member.voice.selfDeaf || member.voice.serverDeaf) return false;
  const activeMembers = channel.members.filter(
    (voiceMember) =>
      !voiceMember.user.bot &&
      !voiceMember.voice.selfDeaf &&
      !voiceMember.voice.serverDeaf,
  );
  return activeMembers.size >= 2;
}

function refreshVoiceEligibility(channel: VoiceState["channel"]): void {
  if (!channel || channel.type !== ChannelType.GuildVoice) return;
  const now = Date.now();
  for (const member of channel.members.values()) {
    const key = profileKey(member.guild.id, member.id);
    if (voiceEligible(member)) {
      if (!voiceJoinedAt.has(key)) voiceJoinedAt.set(key, now);
    } else {
      voiceJoinedAt.delete(key);
    }
  }
}

async function awardVoiceXpForMember(member: GuildMember): Promise<void> {
  const key = profileKey(member.guild.id, member.id);
  const enteredAt = voiceJoinedAt.get(key);
  if (!enteredAt || Date.now() - enteredAt < VOICE_XP_INTERVAL_MS || !voiceEligible(member)) return;

  const result = await awardXp(member.guild.id, member.id, VOICE_XP, "voice");
  if (!result) return;

  const channel = member.voice.channel;
  if (!channel || channel.type !== ChannelType.GuildVoice) return;
  await announceLevelUp((payload) => channel.send(payload), member.guild.id, member, result);
}

async function awardVoiceXp(client: Client): Promise<void> {
  if (voiceXpTickRunning) return;
  voiceXpTickRunning = true;
  try {
    for (const guild of client.guilds.cache.values()) {
      for (const state of guild.voiceStates.cache.values()) {
        const member = state.member;
        if (!member || member.user.bot) continue;
        const key = profileKey(guild.id, member.id);
        if (!voiceEligible(member)) {
          voiceJoinedAt.delete(key);
          continue;
        }
        if (!voiceJoinedAt.has(key)) {
          voiceJoinedAt.set(key, Date.now());
          continue;
        }
        try {
          await awardVoiceXpForMember(member);
        } catch (err) {
          logger.error(
            { err, guildId: guild.id, userId: member.id },
            "Failed to award voice XP to member",
          );
        }
      }
    }
  } finally {
    voiceXpTickRunning = false;
  }
}

export function trackVoiceXpState(oldState: VoiceState, newState: VoiceState): void {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;
  refreshVoiceEligibility(oldState.channel);
  if (newState.channelId !== oldState.channelId) refreshVoiceEligibility(newState.channel);
}

export function startVoiceXp(client: Client): void {
  if (voiceXpTimer) return;

  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    for (const state of guild.voiceStates.cache.values()) {
      const member = state.member;
      if (member && !member.user.bot && voiceEligible(member)) {
        voiceJoinedAt.set(profileKey(guild.id, member.id), now);
      }
    }
  }

  voiceXpTimer = setInterval(() => {
    void awardVoiceXp(client).catch((err: unknown) => {
      logger.error({ err }, "Failed to award voice XP");
    });
  }, VOICE_XP_INTERVAL_MS);
  voiceXpTimer.unref();
}
