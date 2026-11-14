// The room sounds a voice channel can have (see server/src/routes/mood.js and client/src/lib/ambience.js, which makes the sounds).
export const MOODS = [
  { id: 'rain', name: 'Rain', emoji: '🌧️', hint: 'Steady rain on a window' },
  { id: 'fireplace', name: 'Fireplace', emoji: '🔥', hint: 'A crackling fire' },
  { id: 'ocean', name: 'Ocean', emoji: '🌊', hint: 'Slow waves on a beach' },
  { id: 'wind', name: 'Wind', emoji: '🍃', hint: 'Wind through trees' },
  { id: 'night', name: 'Night', emoji: '🌙', hint: 'Crickets on a summer night' },
  { id: 'space', name: 'Deep hum', emoji: '🪐', hint: 'A low, steady hum' },
];
export const MOOD_IDS = MOODS.map((m) => m.id);
export const moodById = (id) => MOODS.find((m) => m.id === id) || null;
