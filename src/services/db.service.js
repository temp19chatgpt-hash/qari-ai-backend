const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const { SUPABASE_URL, SUPABASE_SERVICE_KEY, auth_config } = require('../config/env');

// Initialize Supabase client with service role (bypasses RLS)
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

if (supabase) {
  console.log('[DB] ✅ Supabase client initialized');
} else {
  console.warn('[DB] ⚠️ Supabase not configured — DB features disabled');
}

/**
 * Upsert user on login (create if new, update last_login if existing)
 */
async function upsertUser(qfUserId, name, email) {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from('users')
      .upsert({
        qf_user_id: qfUserId,
        name: name || (email ? email.split('@')[0] : 'Student'),
        email: email || '',
        last_login: new Date().toISOString()
      }, { onConflict: 'qf_user_id' })
      .select()
      .single();

    if (error) throw error;
    console.log(`[DB] User upserted: ${qfUserId}`);
    return data;
  } catch (err) {
    console.error('[DB] upsertUser error:', err.message);
    return null;
  }
}

/**
 * Save a practice session + associated tajweed scores
 */
async function savePracticeSession(qfUserId, analysisResult, meta, audioBuffer = null) {
  if (!supabase || qfUserId === 'guest') return null;
  try {
    let audioUrl = null;
    if (audioBuffer && supabase) {
      try {
        const fileName = `${qfUserId}/${Date.now()}.webm`;
        const { data: uploadData, error: uploadErr } = await supabase.storage
          .from('practice-audio')
          .upload(fileName, audioBuffer, {
            contentType: 'audio/webm',
            upsert: false
          });

        if (!uploadErr && uploadData) {
          const { data: publicUrlData } = supabase.storage
            .from('practice-audio')
            .getPublicUrl(fileName);
          audioUrl = publicUrlData.publicUrl;
        } else {
          console.warn('[DB] Audio upload skipped/failed (ensure bucket exists with correct RLS):', uploadErr?.message);
        }
      } catch (err) {
        console.warn('[DB] Exception uploading audio:', err.message);
      }
    }

    // Calculate metadata for Precision Boxes
    const wordFeedback = analysisResult.word_feedback || [];
    const totalWords = wordFeedback.length;
    // Match ASR pipeline status values: 'correct', 'partial', 'missing'
    const mistakeCount = wordFeedback.filter(w => ['missing'].includes(w.status?.toLowerCase())).length;

    // 1. Insert the practice session
    const { data: session, error: sessionErr } = await supabase
      .from('practice_sessions')
      .insert({
        qf_user_id: qfUserId,
        surah_number: meta.surah,
        ayah_number: meta.ayah,
        score: Math.round(analysisResult.score || 0),
        accuracy: analysisResult.accuracy || 0,
        mistake_count: mistakeCount,
        total_words: totalWords,
        grade: analysisResult.grade || 'N/A',
        raw_text: analysisResult.raw_text || '',
        duration_secs: analysisResult.duration_seconds || analysisResult.duration || 0,
        audio_url: audioUrl
      })
      .select('id')
      .single();

    if (sessionErr) throw sessionErr;
    console.log(`[DB] Practice session saved: id=${session.id}`);

    // 2. Insert tajweed rule scores (aggregating across words)
    const ruleAggregator = {};

    if (Array.isArray(analysisResult.word_feedback)) {
      analysisResult.word_feedback.forEach(word => {
        // Extract from the detailed 'tajweed' array which has the messages
        if (Array.isArray(word.tajweed)) {
          word.tajweed.forEach(tInfo => {
            const rName = tInfo.rule;
            if (!ruleAggregator[rName]) ruleAggregator[rName] = { sum: 0, count: 0, messages: [] };

            ruleAggregator[rName].sum += tInfo.score;
            ruleAggregator[rName].count += 1;

            // Only save actionable warning feedback to keep the database clean
            if (tInfo.severity === 'warning' && tInfo.message) {
              ruleAggregator[rName].messages.push(tInfo.message);
            }
          });
        } else if (word.tajweed_scores) {
          // Fallback just in case
          for (const [rName, rScore] of Object.entries(word.tajweed_scores)) {
            if (!ruleAggregator[rName]) ruleAggregator[rName] = { sum: 0, count: 0, messages: [] };
            ruleAggregator[rName].sum += rScore;
            ruleAggregator[rName].count += 1;
          }
        }
      });
    }

    const tajweedRows = [];
    for (const [ruleName, data] of Object.entries(ruleAggregator)) {
      const avgScore = Math.round((data.sum / data.count) * 100);

      // If there are warnings, join them. Otherwise give positive reinforcement.
      let feedbackStr = '';
      if (data.messages.length > 0) {
        feedbackStr = data.messages.join(' | ');
      } else if (avgScore >= 90) {
        feedbackStr = 'Excellent execution.';
      } else {
        feedbackStr = 'Good.';
      }

      tajweedRows.push({
        session_id: session.id,
        rule_name: ruleName,
        score: avgScore,
        status: avgScore < 80 ? 'warning' : 'ok',
        feedback: feedbackStr
      });
    }

    if (tajweedRows.length > 0) {
      const { error: tajweedErr } = await supabase
        .from('tajweed_scores')
        .insert(tajweedRows);
      if (tajweedErr) console.error('[DB] Tajweed scores insert error:', tajweedErr.message);
      else console.log(`[DB] ${tajweedRows.length} tajweed scores saved`);
    }

    return session.id;
  } catch (err) {
    console.error('[DB] savePracticeSession error:', err.message);
    return null;
  }
}

/**
 * Save a Word Lab attempt
 */
async function saveWordLabAttempt(qfUserId, result, meta) {
  if (!supabase || qfUserId === 'guest') return null;
  try {
    const tajweedBreakdown = {};
    if (result.madd_status) tajweedBreakdown.madd = { status: result.madd_status, score: result.madd_score };
    if (result.ghunnah_status) tajweedBreakdown.ghunnah = { status: result.ghunnah_status };
    if (result.heavy_status) tajweedBreakdown.tafkhim = { status: result.heavy_status };
    if (result.qalqalah_status) tajweedBreakdown.qalqalah = { status: result.qalqalah_status };

    const { error } = await supabase
      .from('word_lab_attempts')
      .insert({
        qf_user_id: qfUserId,
        word_text: meta.word_text || '',
        surah_number: meta.surah || null,
        ayah_number: meta.ayah || null,
        word_position: meta.position || null,
        difficulty: meta.difficulty || 'intermediate',
        score: Math.round(result.score || 0),
        tajweed_json: tajweedBreakdown
      });

    if (error) throw error;
    console.log(`[DB] Word Lab attempt saved for: ${meta.word_text}`);
  } catch (err) {
    console.error('[DB] saveWordLabAttempt error:', err.message);
  }
}

/**
 * Get dashboard stats for a user
 */
async function getDashboardStats(qfUserId, filter = 'recent', userToken = null) {
  if (!supabase || qfUserId === 'guest') return null;

  // Initialize variables that will be used in the return statement
  let totalSessions = 0;
  let uniqueAyahs = 0;
  let streak = 0;
  let avgScore = 0;
  let daysThisWeek = 0;
  let practiceDates = [];
  let recentSessions = [];
  let reviewPending = [];
  let nextAction = null;

  try {
    // Run independent dashboard queries in parallel to reduce load time.
    const [dbUserResult, sessionCountResult, ayahDataResult, dateDataResult, scoreDataResult, analysisWindowResult] = await Promise.all([
      supabase
        .from('users')
        .select('name')
        .eq('qf_user_id', qfUserId)
        .single(),
      supabase
        .from('practice_sessions')
        .select('*', { count: 'exact', head: true })
        .eq('qf_user_id', qfUserId),
      supabase
        .from('practice_sessions')
        .select('surah_number, ayah_number')
        .eq('qf_user_id', qfUserId),
      supabase
        .from('practice_sessions')
        .select('created_at')
        .eq('qf_user_id', qfUserId)
        .order('created_at', { ascending: false }),
      supabase
        .from('practice_sessions')
        .select('score')
        .eq('qf_user_id', qfUserId),
      (() => {
        // Build analysisWindow query based on filter parameter
        let query = supabase
          .from('practice_sessions')
          .select('id, surah_number, ayah_number, score, accuracy, grade, created_at, mistake_count, total_words, duration_secs')
          .eq('qf_user_id', qfUserId);

        // Apply filter conditions
        if (filter === 'struggling') {
          query = query.lt('score', 80); // Sessions with score < 80
        } else if (filter === 'this_week') {
          // Calculate 7-day window start at midnight UTC.
          const sevenDaysAgo = new Date();
          sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
          sevenDaysAgo.setHours(0, 0, 0, 0);
          const sevenDaysAgoStr = sevenDaysAgo.toISOString();
          query = query.gte('created_at', sevenDaysAgoStr); // Sessions from last 7 days
        }

        // Keep recent/struggling compact; week should include full 7-day dataset.
        const base = query.order('created_at', { ascending: false });
        return filter === 'this_week' ? base : base.limit(20);
      })()
    ]);

    const dbName = dbUserResult.data?.name;

    totalSessions = sessionCountResult.count || 0;

    uniqueAyahs = new Set(
      (ayahDataResult.data || []).map(r => `${r.surah_number}:${r.ayah_number}`)
    )
      .size;

    const toLocalYmd = (isoTs) => {
      const d = new Date(isoTs);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    };

    practiceDates = [...new Set(
      (dateDataResult.data || []).map(r => toLocalYmd(r.created_at))
    )].sort().reverse();

    streak = 0;
    if (userToken && auth_config && auth_config.client_id) {
      try {
        const streakRes = await axios.get('https://apis-prelive.quran.foundation/auth/v1/streaks/current-streak-days?type=QURAN', {
          headers: {
            'Accept': 'application/json',
            'x-auth-token': userToken,
            'x-client-id': auth_config.client_id,
            'x-timezone': 'Asia/Kolkata'
          },
          timeout: 5000
        });
        if (streakRes.data && streakRes.data.success && streakRes.data.data && typeof streakRes.data.data.days !== 'undefined') {
          streak = streakRes.data.data.days;
        } else {
          streak = calculateStreak(practiceDates);
        }
      } catch (e) {
        streak = calculateStreak(practiceDates); // fallback
      }
    } else {
      streak = calculateStreak(practiceDates);
    }

    // Calculate days active in the last 7 days for "Weekly Volume"
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    const y = sevenDaysAgo.getFullYear();
    const m = String(sevenDaysAgo.getMonth() + 1).padStart(2, '0');
    const d = String(sevenDaysAgo.getDate()).padStart(2, '0');
    const sevenDaysAgoStr = `${y}-${m}-${d}`;
    daysThisWeek = practiceDates.filter(d => d >= sevenDaysAgoStr).length;

    avgScore = scoreDataResult.data && scoreDataResult.data.length > 0
      ? Math.round(scoreDataResult.data.reduce((a, b) => a + (b.score || 0), 0) / scoreDataResult.data.length)
      : 0;

    const analysisWindow = analysisWindowResult.data || [];

    const sessionIds = (analysisWindow || []).map(s => s.id);
    let allFeedback = [];
    if (sessionIds.length > 0) {
      const { data } = await supabase
        .from('tajweed_scores')
        .select('session_id, rule_name, score, feedback')
        .in('session_id', sessionIds);
      allFeedback = data || [];
    }

    const CRITICAL_RULES = ['ghunnah', 'madd', 'qalqalah'];

    // Identify sessions needing review
    const reviewItems = (analysisWindow || []).map(session => {
      const rules = allFeedback.filter(f => f.session_id === session.id);
      const criticalFailures = rules.filter(r => CRITICAL_RULES.includes(r.rule_name.toLowerCase()) && r.score < 80);
      const worstRule = rules.sort((a, b) => a.score - b.score)[0];

      const needsReview = session.score < 80 || criticalFailures.length > 0;

      return {
        ...session,
        needsReview,
        criticalFailures,
        weakestRule: worstRule,
        tajweedAvg: rules.length > 0 ? Math.round(rules.reduce((a, b) => a + b.score, 0) / rules.length) : session.score
      };
    }).filter(s => s.needsReview);

    const RULE_PRINT_NAMES = {
      'madd_2': 'Normal Madd (2)',
      'madd_s': 'Separated Madd',
      'madd_c': 'Connected Madd',
      'madd_6': 'Necessary Madd (6)',
      'ghunnah': 'Ghunnah / Nasal',
      'qalqalah': 'Qalqala (Echo)',
      'heavy': 'Tafkhim (Heavy)',
      'idgham': 'Idgham / Ghunnah',
      'iqlab': 'Iqlab',
      'lam_shamsiyyah': 'Lam Shamsiyah',
      'lam_qamariyyah': 'Lam Qamariyah'
    };

    const getReadableName = (key) => {
      if (!key) return '';
      const lower = key.toLowerCase();
      if (RULE_PRINT_NAMES[lower]) return RULE_PRINT_NAMES[lower];
      return key.replace(/_/g, ' ').split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    };

    // Sort review items: 1. Critical Rule Fails, 2. Lowest Score
    reviewItems.sort((a, b) => {
      if (a.criticalFailures.length > b.criticalFailures.length) return -1;
      if (a.criticalFailures.length < b.criticalFailures.length) return 1;
      return a.score - b.score;
    });

    const sessionWindow = filter === 'this_week'
      ? (analysisWindow || [])
      : (analysisWindow || []).slice(0, 10);

    recentSessions = sessionWindow.map(s => {
      const rules = allFeedback.filter(f => f.session_id === s.id);
      const weakest = rules.sort((a, b) => a.score - b.score)[0];
      return {
        ...s,
        insight: (weakest && weakest.score < 80) ? `${getReadableName(weakest.rule_name)} needs more focus.` : null,
        confidence: s.score >= 90 ? 'High' : s.score >= 75 ? 'Medium' : 'Low',
        tajweedAvg: rules.length > 0 ? Math.round(rules.reduce((a, b) => a + b.score, 0) / rules.length) : s.score
      };
    });

    // 6. Review Pending List (Top 3)
    reviewPending = reviewItems.slice(0, 3).map(r => ({
      surah_number: r.surah_number,
      ayah_number: r.ayah_number,
      score: r.score,
      created_at: r.created_at,
      insight: r.criticalFailures.length > 0
        ? `${getReadableName(r.criticalFailures[0].rule_name)} issue`
        : r.weakestRule
          ? `${getReadableName(r.weakestRule.rule_name)} needs work`
          : 'Low overall score'
    }));

    // 7. Next Action Engine Logic
    if (reviewItems.length > 0) {
      const target = reviewItems[0];
      const rule = target.criticalFailures[0] || target.weakestRule;

      nextAction = {
        type: 'review',
        label: `Review Required: Surah ${target.surah_number}, Ayah ${target.ayah_number} ⚠️`,
        sub: rule
          ? `Your ${getReadableName(rule.rule_name)} needs focus. This affects pronunciation clarity.`
          : `Revisit this verse to improve your ${target.score}% accuracy.`,
        surah: target.surah_number,
        ayah: target.ayah_number,
        rule: rule?.rule_name
      };
    } else if (analysisWindow && analysisWindow.length > 0) {
      const latest = analysisWindow[0];
      nextAction = {
        type: 'progression',
        label: `Continue to Next Verse`,
        sub: `You mastered Ayah ${latest.ayah_number}. Ready for Ayah ${latest.ayah_number + 1}?`,
        surah: latest.surah_number,
        ayah: latest.ayah_number + 1
      };
    } else {
      // 🌟 Starter Goal for New Users (Judge Onboarding)
      nextAction = {
        type: 'starter',
        label: 'Kickstart your Journey! 🚀',
        sub: 'Start with Surah Al-Fatiha (The Opening) to baseline your Tajweed.',
        surah: 1,
        ayah: 1
      };
    }

    return {
      streak,
      totalSessions: totalSessions || 0,
      uniqueAyahs,
      avgScore,
      daysThisWeek,
      practiceDates,
      recentSessions,
      reviewPending,
      nextAction,
      dbName
    };
  } catch (err) {
    console.error('[DB] getDashboardStats error:', err.message);
    return {
      streak: 0,
      totalSessions: 0,
      uniqueAyahs: 0,
      avgScore: 0,
      daysThisWeek: 0,
      practiceDates: [],
      recentSessions: [],
      reviewPending: [],
      nextAction: null
    };
  }
}

/**
 * Fetch specific audio URL for a session on-demand
 */
async function getSessionAudioUrl(sessionId) {
  if (!supabase) return null;
  try {
    // 🛡️ Guard: Validate integer range for Postgres (int4)
    const idNum = Number(sessionId);
    if (isNaN(idNum) || idNum > 2147483647 || idNum < 1) {
      return null; 
    }

    const { data, error } = await supabase
      .from('practice_sessions')
      .select('audio_url')
      .eq('id', idNum)
      .single();
    if (error) throw error;
    return data?.audio_url;
  } catch (err) {
    console.error('[DB] getSessionAudioUrl error:', err.message);
    return null;
  }
}

/**
 * Get tajweed mastery data for radar chart
 */
async function getTajweedMastery(qfUserId) {
  if (!supabase || qfUserId === 'guest') return null;
  try {
    // Get all tajweed scores for this user's sessions
    const { data: sessions } = await supabase
      .from('practice_sessions')
      .select('id')
      .eq('qf_user_id', qfUserId);

    if (!sessions || sessions.length === 0) return {};

    const sessionIds = sessions.map(s => s.id);

    const { data: scores } = await supabase
      .from('tajweed_scores')
      .select('rule_name, score')
      .in('session_id', sessionIds);

    // Average by rule
    const ruleMap = {};
    (scores || []).forEach(s => {
      if (!ruleMap[s.rule_name]) ruleMap[s.rule_name] = [];
      ruleMap[s.rule_name].push(s.score);
    });

    const mastery = {};
    for (const [rule, scores] of Object.entries(ruleMap)) {
      mastery[rule] = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    }

    return mastery;
  } catch (err) {
    console.error('[DB] getTajweedMastery error:', err.message);
    return null;
  }
}

/**
 * Calculate streak from sorted date strings (newest first)
 */
function calculateStreak(dates) {
  if (!Array.isArray(dates) || dates.length === 0) return 0;

  const MS_PER_DAY = 86400000;

  // Parse YYYY-M-D / YYYY-MM-DD safely and return a day index (UTC-based integer day)
  // from local calendar components to avoid timezone off-by-one issues.
  const parseDayIndex = (value) => {
    if (typeof value !== 'string') return null;
    const match = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;

    const utcMs = Date.UTC(year, month - 1, day);
    const check = new Date(utcMs);

    // Reject impossible dates like 2024-02-31.
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() !== month - 1 ||
      check.getUTCDate() !== day
    ) {
      return null;
    }

    return Math.floor(utcMs / MS_PER_DAY);
  };

  // Build today's day index from local date parts (user calendar day), then anchor in UTC.
  const now = new Date();
  const todayUtcMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const todayIndex = Math.floor(todayUtcMs / MS_PER_DAY);

  // Normalize, dedupe, and drop invalid/future days.
  const daySet = new Set();
  for (const raw of dates) {
    const dayIndex = parseDayIndex(raw);
    if (dayIndex === null) continue;
    if (dayIndex > todayIndex) continue;
    daySet.add(dayIndex);
  }

  if (daySet.size === 0) return 0;

  let latestDay = -Infinity;
  for (const d of daySet) {
    if (d > latestDay) latestDay = d;
  }

  // Active streak only if latest activity is today or yesterday.
  if (todayIndex - latestDay > 1) return 0;

  let streak = 0;
  let cursor = latestDay;
  while (daySet.has(cursor)) {
    streak++;
    cursor--;
  }

  return streak;
}

module.exports = {
  upsertUser,
  savePracticeSession,
  saveWordLabAttempt,
  getDashboardStats,
  getTajweedMastery,
  getSessionAudioUrl
};
