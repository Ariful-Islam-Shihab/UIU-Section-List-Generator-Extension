document.addEventListener('DOMContentLoaded', function() {
  console.log('Popup DOM loaded');
  
  // Add a small delay to ensure connection
  setTimeout(() => {
    loadData();
  }, 100);
  
  document.getElementById('clear-all').addEventListener('click', clearAll);
  document.getElementById('refresh').addEventListener('click', loadData);

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'NEW_DATA') {
      loadData();
    }
  });
});

const LAST_SELECTED_DEPT_KEY = 'lastSelectedDept';

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sanitizeFilenamePart(value) {
  return String(value)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 60);
}

function toText(value) {
  if (value === null || typeof value === 'undefined') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function toTextLoose(value) {
  if (value === null || typeof value === 'undefined') return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(toTextLoose).map((s) => String(s || '').trim()).filter(Boolean);
    // Avoid exploding the PDF with huge arrays.
    return parts.slice(0, 10).join(', ');
  }
  if (typeof value === 'object') {
    // Common “display” keys.
    const direct =
      pickFirst(value, ['name', 'title', 'fullName', 'displayName', 'label', 'text', 'value']) ||
      pickFirst(value, ['en', 'english', 'desc', 'description']);
    if (direct) return direct;

    // If it’s a simple object with a single primitive value.
    const keys = Object.keys(value);
    if (keys.length === 1) {
      return toTextLoose(value[keys[0]]);
    }
  }
  return '';
}

function normalizeKeyForMatch(keyPath) {
  return String(keyPath)
    .toLowerCase()
    .replace(/\[(\d+)\]/g, ' ') // strip indexes
    .replace(/[^a-z0-9]+/g, ' ') // normalize separators
    .trim();
}

function flattenForSearch(root) {
  const entries = [];
  const seen = new Set();
  const maxDepth = 6;
  const maxNodes = 900;
  let visited = 0;

  const queue = [{ value: root, path: '', depth: 0 }];

  while (queue.length > 0) {
    const { value, path, depth } = queue.shift();
    visited += 1;
    if (visited > maxNodes) break;
    if (!value || depth > maxDepth) continue;

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const text = toTextLoose(value).trim();
      if (text) {
        const key = path || '(root)';
        const norm = normalizeKeyForMatch(key);
        const sig = `${norm}::${text}`;
        if (!seen.has(sig)) {
          seen.add(sig);
          entries.push({ keyPath: key, keyNorm: norm, text });
        }
      }
      continue;
    }

    if (Array.isArray(value)) {
      // If it’s an array of primitives, add a compact summary.
      const primitiveParts = value
        .filter((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .map((v) => toTextLoose(v).trim())
        .filter(Boolean);
      if (primitiveParts.length > 0) {
        const text = primitiveParts.slice(0, 10).join(', ');
        const key = path || '(root)';
        const norm = normalizeKeyForMatch(key);
        const sig = `${norm}::${text}`;
        if (!seen.has(sig)) {
          seen.add(sig);
          entries.push({ keyPath: key, keyNorm: norm, text });
        }
      }

      // Also traverse objects inside arrays.
      for (let i = 0; i < Math.min(value.length, 20); i++) {
        const el = value[i];
        if (el && (typeof el === 'object' || Array.isArray(el))) {
          queue.push({ value: el, path: path ? `${path}[${i}]` : `[${i}]`, depth: depth + 1 });
        }
      }
      continue;
    }

    if (typeof value === 'object') {
      // If the object itself can be rendered as a useful label, store it too.
      const asText = toTextLoose(value).trim();
      if (asText) {
        const key = path || '(root)';
        const norm = normalizeKeyForMatch(key);
        const sig = `${norm}::${asText}`;
        if (!seen.has(sig)) {
          seen.add(sig);
          entries.push({ keyPath: key, keyNorm: norm, text: asText });
        }
      }

      for (const [k, v] of Object.entries(value)) {
        if (!v) continue;
        const nextPath = path ? `${path}.${k}` : k;
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          const text = toTextLoose(v).trim();
          if (text) {
            const norm = normalizeKeyForMatch(nextPath);
            const sig = `${norm}::${text}`;
            if (!seen.has(sig)) {
              seen.add(sig);
              entries.push({ keyPath: nextPath, keyNorm: norm, text });
            }
          }
        } else if (Array.isArray(v) || typeof v === 'object') {
          queue.push({ value: v, path: nextPath, depth: depth + 1 });
        }
      }
    }
  }

  return entries;
}

function pickFromFlattened(entries, { include, exclude, preferAlpha = false, maxLen = 160 }) {
  const includeList = Array.isArray(include) ? include : [include];
  const excludeList = exclude ? (Array.isArray(exclude) ? exclude : [exclude]) : [];

  const candidates = entries.filter((e) => {
    if (!e.text) return false;
    if (e.text.length > maxLen) return false;
    if (preferAlpha && !/[a-z]/i.test(e.text)) return false;
    const inOk = includeList.some((rx) => rx.test(e.keyNorm));
    if (!inOk) return false;
    const exHit = excludeList.some((rx) => rx.test(e.keyNorm));
    return !exHit;
  });

  if (candidates.length === 0) return '';

  // Prefer values from “more specific” key paths and longer (but not too long) text.
  candidates.sort((a, b) => {
    const aDepth = (a.keyPath.match(/\./g) || []).length;
    const bDepth = (b.keyPath.match(/\./g) || []).length;
    if (aDepth !== bDepth) return bDepth - aDepth;
    if (a.text.length !== b.text.length) return b.text.length - a.text.length;
    return a.keyPath.localeCompare(b.keyPath);
  });

  return candidates[0].text.trim();
}

function findFirstNamedValue(obj, keyRegex) {
  if (!obj || typeof obj !== 'object') return '';
  for (const [k, v] of Object.entries(obj)) {
    if (!keyRegex.test(k)) continue;
    const text = joinNames(v) || toTextLoose(v);
    if (text) return text;
  }
  return '';
}

function findMeetingArrays(root) {
  const arrays = [];
  const queue = [{ value: root, depth: 0 }];
  const maxDepth = 6;
  const maxNodes = 500;
  let visited = 0;

  while (queue.length > 0) {
    const { value, depth } = queue.shift();
    visited += 1;
    if (visited > maxNodes) break;
    if (!value || depth > maxDepth) continue;

    if (Array.isArray(value)) {
      const sample = value.find((v) => v && typeof v === 'object');
      if (sample && typeof sample === 'object') {
        const keys = Object.keys(sample).join(' ').toLowerCase();
        const looksLikeMeeting =
          /day|days|dow|weekday|start|end|time|begin|finish|room|location|building/.test(keys);
        if (looksLikeMeeting) arrays.push(value);
      }
      continue;
    }

    if (typeof value === 'object') {
      for (const v of Object.values(value)) {
        if (v && (typeof v === 'object' || Array.isArray(v))) {
          queue.push({ value: v, depth: depth + 1 });
        }
      }
    }
  }

  return arrays;
}

function extractScheduleAndRoom(sectionObj) {
  // First try simple direct keys.
  const directSchedule = pickFirst(sectionObj, ['schedule', 'meeting', 'time', 'times', 'meetingTime', 'meetingTimes']);
  const directRoom =
    pickFirst(sectionObj, ['room_details', 'roomDetails']) ||
    pickFirst(sectionObj, ['classRoom', 'classroom', 'room', 'roomNumber', 'location', 'facility', 'where']) ||
    pickFirst(sectionObj, ['building']);

  let schedule = directSchedule || '';
  let classRoom = directRoom || '';

  const meetingArrays = findMeetingArrays(sectionObj);
  const scheduleParts = [];
  const roomParts = [];

  for (const arr of meetingArrays) {
    for (const m of arr.slice(0, 25)) {
      if (!m || typeof m !== 'object') continue;

      const days =
        toTextLoose(m.days) ||
        toTextLoose(m.day) ||
        toTextLoose(m.meetingDays) ||
        toTextLoose(m.dow) ||
        toTextLoose(m.weekday);
      const start =
        toTextLoose(m.start) ||
        toTextLoose(m.startTime) ||
        toTextLoose(m.beginTime) ||
        toTextLoose(m.begin) ||
        toTextLoose(m.start_time) ||
        toTextLoose(m.begin_time);
      const end =
        toTextLoose(m.end) ||
        toTextLoose(m.endTime) ||
        toTextLoose(m.finishTime) ||
        toTextLoose(m.finish) ||
        toTextLoose(m.end_time) ||
        toTextLoose(m.finish_time);
      const time = start && end ? `${start}-${end}` : start || end;

      const sched = [days, time].filter(Boolean).join(' ').trim();
      if (sched) scheduleParts.push(sched);

      const room =
        toTextLoose(m.room_details) ||
        toTextLoose(m.roomDetails) ||
        toTextLoose(m.classRoom) ||
        toTextLoose(m.classroom) ||
        toTextLoose(m.room) ||
        toTextLoose(m.roomNumber) ||
        toTextLoose(m.location) ||
        toTextLoose(m.facility) ||
        toTextLoose(m.where) ||
        [toTextLoose(m.building), toTextLoose(m.campus)].filter(Boolean).join(' ');
      if (room) roomParts.push(room.trim());
    }
  }

  if (!schedule && scheduleParts.length > 0) {
    schedule = Array.from(new Set(scheduleParts)).join('; ');
  }
  if (!classRoom && roomParts.length > 0) {
    classRoom = Array.from(new Set(roomParts)).join('; ');
  }

  // Final fallback: flatten and pick by key patterns.
  if (!schedule || !classRoom) {
    const flat = flattenForSearch(sectionObj);
    if (!schedule) {
      schedule = pickFromFlattened(flat, {
        include: [/meeting time/, /meetingtimes/, /schedule/, /times?/, /days?/, /start time/, /end time/],
        exclude: [/timezone/, /time zone/],
        maxLen: 200,
      });
    }
    if (!classRoom) {
      classRoom = pickFromFlattened(flat, {
        include: [/class room/, /classroom/, /room( number)?/, /location/, /facility/, /building/],
        exclude: [/room capacity/],
        maxLen: 120,
      });
    }
  }

  return { schedule: schedule || '', classRoom: classRoom || '' };
}

function pickFirst(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const v = obj[key];
      const t = toText(v);
      if (t) return t;
    }
  }
  return '';
}

function joinNames(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((v) => {
        if (!v) return '';
        if (typeof v === 'string') return v;
        if (typeof v === 'object') {
          return (
            pickFirst(v, ['name', 'fullName', 'displayName']) ||
            [toText(v.firstName), toText(v.lastName)].filter(Boolean).join(' ')
          );
        }
        return '';
      })
      .filter(Boolean);
    return parts.join(', ');
  }
  if (typeof value === 'object') {
    return (
      pickFirst(value, ['name', 'fullName', 'displayName']) ||
      [toText(value.firstName), toText(value.lastName)].filter(Boolean).join(' ')
    );
  }
  return '';
}

function formatSchedule(sectionObj) {
  if (!sectionObj || typeof sectionObj !== 'object') return '';

  const direct = pickFirst(sectionObj, ['schedule', 'meeting', 'time', 'times', 'meetingTime', 'meetingTimes']);
  if (direct) return direct;

  const meetings =
    sectionObj.meetings ||
    sectionObj.meetingTimes ||
    sectionObj.meeting_patterns ||
    sectionObj.scheduleEntries ||
    sectionObj.schedule;

  if (!meetings) return '';

  if (Array.isArray(meetings)) {
    const parts = meetings
      .map((m) => {
        if (!m || typeof m !== 'object') return '';
        const days = pickFirst(m, ['days', 'day', 'meetingDays', 'dow']);
        const start = pickFirst(m, ['start', 'startTime', 'beginTime']);
        const end = pickFirst(m, ['end', 'endTime', 'finishTime']);
        const time = start && end ? `${start}-${end}` : start || end;
        const text = [days, time].filter(Boolean).join(' ');
        return text;
      })
      .filter(Boolean);
    return parts.join('; ');
  }

  if (typeof meetings === 'object') {
    const days = pickFirst(meetings, ['days', 'day', 'meetingDays', 'dow']);
    const start = pickFirst(meetings, ['start', 'startTime', 'beginTime']);
    const end = pickFirst(meetings, ['end', 'endTime', 'finishTime']);
    const time = start && end ? `${start}-${end}` : start || end;
    return [days, time].filter(Boolean).join(' ');
  }

  return '';
}

function formatRoom(sectionObj) {
  if (!sectionObj || typeof sectionObj !== 'object') return '';
  return (
    pickFirst(sectionObj, ['classRoom', 'classroom', 'room', 'roomNumber', 'location', 'facility', 'where']) ||
    pickFirst(sectionObj, ['building'])
  );
}

function findLikelySectionArrays(root) {
  const found = [];
  const seen = new Set();
  const queue = [{ value: root, depth: 0 }];
  const maxDepth = 6;
  const maxNodes = 300;
  let visited = 0;

  while (queue.length > 0) {
    const { value, depth } = queue.shift();
    visited += 1;
    if (visited > maxNodes) break;
    if (!value || depth > maxDepth) continue;

    if (Array.isArray(value)) {
      // If it's an array of objects with section-ish keys, treat as candidate.
      const sample = value.find((v) => v && typeof v === 'object');
      if (sample && typeof sample === 'object') {
        const keys = Object.keys(sample);
        const hasSectionSignals =
          keys.some((k) => /section|instructor|faculty|meeting|schedule|room|location|course/i.test(k)) ||
          keys.some((k) => /code|title|subject|catalog/i.test(k));
        if (hasSectionSignals && !seen.has(value)) {
          seen.add(value);
          found.push(value);
        }
      }
      continue;
    }

    if (typeof value === 'object') {
      // Common container keys first.
      const directKeys = ['sections', 'sectionList', 'classes', 'classSections', 'results', 'items', 'data'];
      for (const k of directKeys) {
        if (Array.isArray(value[k]) && !seen.has(value[k])) {
          seen.add(value[k]);
          found.push(value[k]);
        }
      }

      for (const v of Object.values(value)) {
        if (v && (typeof v === 'object' || Array.isArray(v))) {
          queue.push({ value: v, depth: depth + 1 });
        }
      }
    }
  }

  return found;
}

function looksLikeUcamCoursesPayload(root) {
  if (!root || typeof root !== 'object') return false;
  const courses = root.data && Array.isArray(root.data.courses) ? root.data.courses : null;
  if (!courses || courses.length === 0) return false;
  const first = courses.find((c) => c && typeof c === 'object');
  if (!first) return false;
  const hasCourseCode = typeof first.course_code === 'string' || typeof first.courseCode === 'string';
  const hasCourseName = typeof first.course_name === 'string' || typeof first.courseName === 'string';
  const hasSections = Array.isArray(first.sections);
  return Boolean(hasCourseCode && hasCourseName && hasSections);
}

function getCoursesFromUcamPayload(root) {
  if (!looksLikeUcamCoursesPayload(root)) return [];
  const courses = root.data.courses;
  const out = [];
  for (const c of courses) {
    if (!c || typeof c !== 'object') continue;
    const formal = toTextLoose(c.formal_code || c.formalCode).trim();
    const code = toTextLoose(c.course_code || c.courseCode).trim();
    const name = toTextLoose(c.course_name || c.courseName).trim();
    const id = formal || code;
    if (!id) continue;
    out.push({ id, formalCode: formal || code, courseName: name });
  }

  const seen = new Set();
  const deduped = [];
  for (const c of out) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    deduped.push(c);
  }
  deduped.sort((a, b) => `${a.formalCode} ${a.courseName}`.localeCompare(`${b.formalCode} ${b.courseName}`));
  return deduped;
}

function formatUcamSchedule(schedule) {
  if (!Array.isArray(schedule)) return '';

  function formatTime(value) {
    const s = String(value || '').trim();
    // Expect "HH:MM" or "H:MM"; remove leading zero from hour.
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return s;
    const hour = String(Number(m[1]));
    return `${hour}:${m[2]}`;
  }

  const lines = [];
  const seen = new Set();

  for (const s of schedule) {
    if (!s || typeof s !== 'object') continue;
    const day = toTextLoose(s.day).trim();
    const startRaw = toTextLoose(s.start_time) || toTextLoose(s.startTime) || toTextLoose(s.start);
    const endRaw = toTextLoose(s.end_time) || toTextLoose(s.endTime) || toTextLoose(s.end);
    const start = formatTime(startRaw);
    const end = formatTime(endRaw);

    let line = '';
    if (day && start && end) line = `${day}: ${start} - ${end}`;
    else if (day && start) line = `${day}: ${start}`;
    else if (day && end) line = `${day}: ${end}`;
    else line = [day, start, end].filter(Boolean).join(' ').trim();

    line = String(line || '').trim();
    if (!line) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }

  return lines.join('\n');
}

function extractRowsFromUcamCoursesPayload(root, options) {
  const courseFilter = options && options.courseFilter ? options.courseFilter : null;
  const courses = root.data.courses;
  const rows = [];

  for (const course of courses) {
    if (!course || typeof course !== 'object') continue;

    const courseId =
      toTextLoose(course.formal_code || course.formalCode).trim() ||
      toTextLoose(course.course_code || course.courseCode).trim();
    if (courseFilter && courseId && !courseFilter.has(courseId)) continue;

    const courseTitle = toTextLoose(course.course_name || course.courseName).trim();
    const courseCode = toTextLoose(course.formal_code || course.formalCode || course.course_code || course.courseCode).trim();

    const sections = Array.isArray(course.sections) ? course.sections : [];
    for (const sectionObj of sections) {
      if (!sectionObj || typeof sectionObj !== 'object') continue;

      const section =
        toTextLoose(sectionObj.section_name || sectionObj.sectionName || sectionObj.section || sectionObj.section_code || sectionObj.sectionCode).trim();
      const faculty =
        toTextLoose(sectionObj.faculty_name || sectionObj.facultyName || sectionObj.instructor || sectionObj.teacher || sectionObj.tutor).trim();

      const schedule =
        formatUcamSchedule(sectionObj.schedule) ||
        toTextLoose(sectionObj.schedule_text || sectionObj.scheduleText) ||
        extractScheduleAndRoom(sectionObj).schedule;
      const classRoom =
        toTextLoose(sectionObj.room_details || sectionObj.roomDetails || sectionObj.classRoom || sectionObj.classroom || sectionObj.room) ||
        extractScheduleAndRoom(sectionObj).classRoom;

      const rowCourseCode =
        toTextLoose(sectionObj.formal_code || sectionObj.formalCode || sectionObj.course_code || sectionObj.courseCode) || courseCode;
      const rowCourseTitle =
        toTextLoose(sectionObj.course_name || sectionObj.courseName || sectionObj.course_title || sectionObj.courseTitle) || courseTitle;

      const any = [rowCourseCode, rowCourseTitle, section, faculty, schedule, classRoom].some(Boolean);
      if (!any) continue;

      rows.push({
        courseCode: String(rowCourseCode || '').trim(),
        courseTitle: String(rowCourseTitle || '').trim(),
        section: String(section || '').trim(),
        faculty: String(faculty || '').trim(),
        schedule: String(schedule || '').trim(),
        classRoom: String(classRoom || '').trim(),
      });
    }
  }

  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    const key = `${r.courseCode}__${r.section}__${r.schedule}__${r.classRoom}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  deduped.sort((a, b) => {
    const aKey = `${a.courseCode} ${a.section}`.trim();
    const bKey = `${b.courseCode} ${b.section}`.trim();
    return aKey.localeCompare(bKey);
  });

  return deduped;
}

function normalizeLookupKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function preferLongerText(current, next) {
  const a = String(current || '').trim();
  const b = String(next || '').trim();
  if (!b) return a;
  if (!a) return b;
  return b.length > a.length ? b : a;
}

function buildFallbackIndexes(capturedData) {
  const byCourseCode = new Map();
  const bySection = new Map();

  const queue = [{ value: capturedData, depth: 0 }];
  const maxDepth = 6;
  const maxNodes = 550;
  let visited = 0;

  while (queue.length > 0) {
    const { value, depth } = queue.shift();
    visited += 1;
    if (visited > maxNodes) break;
    if (!value || depth > maxDepth) continue;

    if (Array.isArray(value)) {
      for (let i = 0; i < Math.min(value.length, 40); i++) {
        const el = value[i];
        if (el && (typeof el === 'object' || Array.isArray(el))) {
          queue.push({ value: el, depth: depth + 1 });
        }
      }
      continue;
    }

    if (typeof value !== 'object') continue;

    const keyHint = Object.keys(value).join(' ').toLowerCase();
    const looksRelevant = /course|subject|catalog|code|title|name|section|crn|faculty|instructor|teacher|lecturer|professor|meeting|schedule|room|location|building/.test(
      keyHint
    );
    if (looksRelevant) {
      const flat = flattenForSearch(value);

      const courseCode =
        pickFromFlattened(flat, {
          include: [/course code/, /subject code/, /catalog( number| no)?/, /courseid/, /subject/, /code/],
          exclude: [/zip/, /barcode/, /access code/],
          maxLen: 80,
        }) ||
        pickFirst(value, ['courseCode', 'course_code', 'subjectCode', 'subject', 'code']);

      const courseTitle =
        pickFromFlattened(flat, {
          include: [/course title/, /subject title/, /course name/, /course descr/, /description/, /descr/, /long name/, /title/, /name/],
          exclude: [/building name/, /room name/, /faculty name/, /last name/, /first name/, /department name/, /section name/],
          preferAlpha: true,
          maxLen: 160,
        }) ||
        pickFirst(value, ['courseTitle', 'course_title', 'title', 'courseName', 'name', 'description', 'desc']);

      const section =
        pickFromFlattened(flat, {
          include: [/section number/, /section code/, /section id/, /class section/, /section/, /crn/],
          exclude: [/cross section/],
          maxLen: 60,
        }) ||
        pickFirst(value, ['section', 'sectionNumber', 'section_number', 'classSection', 'class', 'crn']);

      const faculty =
        findFirstNamedValue(value, /faculty|instructor|teachers?|lecturer|professor|staff|tutor/i) ||
        pickFromFlattened(flat, {
          include: [/faculty/, /instructor/, /teacher/, /lecturer/, /professor/, /staff/, /tutor/],
          exclude: [/faculty id/, /instructor id/],
          preferAlpha: true,
          maxLen: 140,
        });

      const { schedule, classRoom } = extractScheduleAndRoom(value);

      if (courseCode) {
        const k = normalizeLookupKey(courseCode);
        const prev = byCourseCode.get(k) || {};
        byCourseCode.set(k, {
          courseCode,
          courseTitle: preferLongerText(prev.courseTitle, courseTitle),
          faculty: preferLongerText(prev.faculty, faculty),
          schedule: preferLongerText(prev.schedule, schedule),
          classRoom: preferLongerText(prev.classRoom, classRoom),
        });
      }

      if (section) {
        const k = normalizeLookupKey(section);
        const prev = bySection.get(k) || {};
        bySection.set(k, {
          section,
          courseCode: preferLongerText(prev.courseCode, courseCode),
          courseTitle: preferLongerText(prev.courseTitle, courseTitle),
          faculty: preferLongerText(prev.faculty, faculty),
          schedule: preferLongerText(prev.schedule, schedule),
          classRoom: preferLongerText(prev.classRoom, classRoom),
        });
      }
    }

    for (const v of Object.values(value)) {
      if (v && (typeof v === 'object' || Array.isArray(v))) {
        queue.push({ value: v, depth: depth + 1 });
      }
    }
  }

  return { byCourseCode, bySection };
}

function extractRowsFromCapturedData(capturedData, options) {
  // If the payload matches the known backend schema, parse it directly.
  if (looksLikeUcamCoursesPayload(capturedData)) {
    return extractRowsFromUcamCoursesPayload(capturedData, options);
  }

  const indexes = buildFallbackIndexes(capturedData);
  const arrays = findLikelySectionArrays(capturedData);
  const rows = [];

  for (const arr of arrays) {
    for (const sectionObj of arr) {
      if (!sectionObj || typeof sectionObj !== 'object') continue;

      const flat = flattenForSearch(sectionObj);

      const courseCode =
        pickFromFlattened(flat, {
          include: [/course code/, /subject code/, /catalog( number| no)?/, /courseid/, /subject/, /code/],
          exclude: [/zip/, /barcode/, /access code/],
          maxLen: 80,
        }) ||
        pickFirst(sectionObj, ['courseCode', 'course_code', 'subjectCode', 'subject', 'code']);

      const courseTitle =
        pickFromFlattened(flat, {
          include: [/course title/, /subject title/, /course name/, /course descr/, /description/, /descr/, /long name/, /title/, /name/],
          exclude: [/building name/, /room name/, /faculty name/, /last name/, /first name/, /department name/, /section name/],
          preferAlpha: true,
          maxLen: 140,
        }) ||
        pickFirst(sectionObj, ['courseTitle', 'course_title', 'title', 'courseName', 'name', 'description', 'desc']);

      const section =
        pickFromFlattened(flat, {
          include: [/section number/, /section code/, /section id/, /class section/, /section/, /crn/],
          exclude: [/cross section/],
          maxLen: 60,
        }) ||
        pickFirst(sectionObj, ['section', 'sectionNumber', 'section_number', 'classSection', 'class', 'crn']);

      const faculty =
        findFirstNamedValue(sectionObj, /faculty|instructor|teachers?|lecturer|professor|staff|tutor/i) ||
        pickFromFlattened(flat, {
          include: [/faculty/, /instructor/, /teacher/, /lecturer/, /professor/, /staff/, /tutor/],
          exclude: [/faculty id/, /instructor id/],
          preferAlpha: true,
          maxLen: 120,
        });

      const { schedule, classRoom } = extractScheduleAndRoom(sectionObj);

      // Fallback: if fields are stored outside the section object, fill from payload-wide indexes.
      const codeKey = courseCode ? normalizeLookupKey(courseCode) : '';
      const sectionKey = section ? normalizeLookupKey(section) : '';
      const fromCode = codeKey ? indexes.byCourseCode.get(codeKey) : null;
      const fromSection = sectionKey ? indexes.bySection.get(sectionKey) : null;

      const finalCourseTitle =
        courseTitle ||
        (fromCode && fromCode.courseTitle) ||
        (fromSection && fromSection.courseTitle) ||
        '';
      const finalFaculty = faculty || (fromCode && fromCode.faculty) || (fromSection && fromSection.faculty) || '';
      const finalSchedule = schedule || (fromSection && fromSection.schedule) || (fromCode && fromCode.schedule) || '';
      const finalClassRoom =
        classRoom || (fromSection && fromSection.classRoom) || (fromCode && fromCode.classRoom) || '';

      const any = [courseCode, finalCourseTitle, section, finalFaculty, finalSchedule, finalClassRoom].some(Boolean);
      if (!any) continue;

      rows.push({
        courseCode,
        courseTitle: finalCourseTitle,
        section,
        faculty: finalFaculty,
        schedule: finalSchedule,
        classRoom: finalClassRoom,
      });
    }
  }

  // Dedupe and sort for readability.
  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    const key = `${r.courseCode}__${r.section}__${r.schedule}__${r.classRoom}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  deduped.sort((a, b) => {
    const aKey = `${a.courseCode} ${a.section}`.trim();
    const bKey = `${b.courseCode} ${b.section}`.trim();
    return aKey.localeCompare(bKey);
  });

  return deduped;
}

function drawTable(doc, { title = '', subtitle = '', rows }) {
  const margin = 40;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const usableWidth = pageWidth - margin * 2;

  const colDefs = [
    { key: 'courseCode', label: 'Course Code', width: 80 },
    { key: 'courseTitle', label: 'Course Title', width: 230 },
    { key: 'section', label: 'Section', width: 60 },
    { key: 'faculty', label: 'Faculty', width: 140 },
    { key: 'schedule', label: 'Schedule', width: 170 },
    { key: 'classRoom', label: 'Class Room', width: 70 },
  ];

  const totalWidth = colDefs.reduce((sum, c) => sum + c.width, 0);
  // If jsPDF units differ or margins change, scale widths to fit.
  const scale = totalWidth > 0 ? usableWidth / totalWidth : 1;
  // Keep rounding errors from causing overflow by letting the last column take the remainder.
  for (let i = 0; i < colDefs.length; i++) {
    colDefs[i].width = Math.floor(colDefs[i].width * scale);
  }
  const used = colDefs.slice(0, -1).reduce((sum, c) => sum + c.width, 0);
  colDefs[colDefs.length - 1].width = Math.max(30, usableWidth - used);

  const paddingX = 4;
  const paddingY = 4;
  const bottomMargin = 40;

  const bodyFontSize = 9;
  const headerFontSize = 9;
  const lineHeight = Math.ceil(bodyFontSize * 1.35);

  function wrapTextToWidth(text, maxWidth) {
    const value = String(text || '').trim();
    if (!value) return [''];

    // First-pass wrapping on spaces.
    const initial = doc.splitTextToSize(value, maxWidth);
    const out = [];

    for (const line of initial) {
      const s = String(line || '');
      if (!s) {
        out.push('');
        continue;
      }

      // If jsPDF couldn't break a very long token (no spaces), hard-wrap by characters.
      if (doc.getTextWidth(s) <= maxWidth) {
        out.push(s);
        continue;
      }

      let remaining = s;
      while (remaining.length > 0) {
        let cut = remaining.length;
        // Binary-ish shrink until it fits.
        while (cut > 1 && doc.getTextWidth(remaining.slice(0, cut)) > maxWidth) {
          cut = Math.floor(cut * 0.7);
        }
        // Then grow a bit to maximize fit.
        while (cut < remaining.length && doc.getTextWidth(remaining.slice(0, cut + 1)) <= maxWidth) {
          cut += 1;
        }
        out.push(remaining.slice(0, cut));
        remaining = remaining.slice(cut);
      }
    }

    return out.length > 0 ? out : [''];
  }

  function clampLines(lines, maxLines) {
    if (!Array.isArray(lines) || lines.length === 0) return [''];
    if (!maxLines || lines.length <= maxLines) return lines;
    const clipped = lines.slice(0, maxLines);
    const last = clipped[clipped.length - 1] || '';
    clipped[clipped.length - 1] = last.length > 0 ? `${last.replace(/\s+$/g, '')}…` : '…';
    return clipped;
  }

  function buildCellLines(rawText, colWidth) {
    const text = String(rawText || '').trim();
    if (!text) return [''];
    // Preserve explicit newlines (used by Schedule formatting).
    if (/\r?\n/.test(text)) {
      return text
        .split(/\r?\n/)
        .map((s) => String(s || '').trim())
        .filter((s) => s.length > 0);
    }
    return wrapTextToWidth(text, colWidth);
  }

  function ellipsizeToWidth(text, maxWidth) {
    const value = String(text || '');
    if (!value) return '';
    if (doc.getTextWidth(value) <= maxWidth) return value;

    const ell = '…';
    const ellW = doc.getTextWidth(ell);
    if (ellW > maxWidth) return '';

    let lo = 0;
    let hi = value.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = value.slice(0, mid).replace(/\s+$/g, '') + ell;
      if (doc.getTextWidth(candidate) <= maxWidth) lo = mid;
      else hi = mid - 1;
    }

    const clipped = value.slice(0, lo).replace(/\s+$/g, '');
    return clipped ? clipped + ell : ell;
  }

  // Pre-wrap header labels and size the header row so wrapped labels never spill.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(headerFontSize);
  const headerLabelLines = colDefs.map((col) => clampLines(wrapTextToWidth(col.label, col.width - paddingX * 2), 2));
  const maxHeaderLines = Math.max(1, ...headerLabelLines.map((l) => l.length));
  const headerLineStep = headerFontSize + 2;
  const headerHeight = paddingY * 2 + maxHeaderLines * headerLineStep;

  let y = margin;

  const hasTitle = Boolean(String(title || '').trim());
  const hasSubtitle = Boolean(String(subtitle || '').trim());

  if (hasTitle) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text(String(title), margin, y);
    y += 18;
  }

  if (hasSubtitle) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.text(String(subtitle), margin, y, { maxWidth: usableWidth });
    y += 16;
  }

  if (hasTitle || hasSubtitle) y += 6;

  function ensureSpace(heightNeeded) {
    if (y + heightNeeded <= pageHeight - bottomMargin) return;
    doc.addPage();
    y = margin;
    drawHeader();
  }

  function drawHeader() {
    // Light gray header background
    doc.setFillColor(245, 245, 245);
    doc.setDrawColor(200, 200, 200);
    doc.rect(margin, y, usableWidth, headerHeight, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(headerFontSize);

    let x = margin;
    for (let i = 0; i < colDefs.length; i++) {
      const col = colDefs[i];
      doc.rect(x, y, col.width, headerHeight, 'S');
      const labelLines = headerLabelLines[i] || [''];
      const startY = y + paddingY + headerFontSize;
      for (let li = 0; li < labelLines.length; li++) {
        // No maxWidth here; we already wrapped/clamped.
        doc.text(labelLines[li], x + paddingX, startY + li * headerLineStep);
      }
      x += col.width;
    }

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(bodyFontSize);
    y += headerHeight;
  }

  drawHeader();

  doc.setDrawColor(210, 210, 210);
  doc.setTextColor(20, 20, 20);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(bodyFontSize);

  for (const row of rows) {
    const cellLines = colDefs.map((col) => {
      const text = toText(row[col.key]).trim();
      const lines = buildCellLines(text, col.width - paddingX * 2);
      // Prevent extremely tall rows from making the PDF unreadable.
      return clampLines(lines, 10);
    });

    const maxLines = Math.max(...cellLines.map((l) => l.length));
    const minRowHeight = paddingY * 2 + bodyFontSize + 2;
    const rowHeight = Math.max(minRowHeight, paddingY * 2 + maxLines * lineHeight);

    ensureSpace(rowHeight);

    let x = margin;
    for (let i = 0; i < colDefs.length; i++) {
      const col = colDefs[i];
      doc.rect(x, y, col.width, rowHeight, 'S');
      const lines = cellLines[i];
      const startY = y + paddingY + bodyFontSize;

      const maxTextWidth = col.width - paddingX * 2;

      for (let li = 0; li < lines.length; li++) {
        const ty = startY + li * lineHeight;
        if (ty > y + rowHeight - paddingY) break;

        // For Schedule (explicit newline-separated entries), never wrap mid-entry.
        // If a line is too long, clip with ellipsis.
        const textLine =
          col.key === 'schedule' ? ellipsizeToWidth(lines[li], maxTextWidth) : String(lines[li] || '');
        doc.text(textLine, x + paddingX, ty);
      }
      x += col.width;
    }

    y += rowHeight;
  }
}

function generatePdfAndDownload(item, options) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert('jsPDF not loaded. Check popup.html includes lib/jspdf.umd.min.js');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });

  const rows = extractRowsFromCapturedData(item.data, options);

  const deptLabel =
    options && typeof options.departmentLabel === 'string' && options.departmentLabel.trim()
      ? options.departmentLabel.trim()
      : item.department;

  if (rows.length > 0) {
    drawTable(doc, { rows });
  } else {
    // Fallback: if we can't detect structure, keep the raw dump rather than producing an empty PDF.
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 40;
    const maxWidth = pageWidth - margin * 2;

    let y = margin;
    doc.setFontSize(10);

    const jsonText = JSON.stringify(item.data, null, 2);
    const lines = doc.splitTextToSize(jsonText, maxWidth);
    const lineHeight = 12;
    const pageBottom = doc.internal.pageSize.getHeight() - margin;

    for (const line of lines) {
      if (y > pageBottom) {
        doc.addPage();
        y = margin;
      }
      doc.text(line, margin, y);
      y += lineHeight;
    }
  }

  const blob = doc.output('blob');
  const blobUrl = URL.createObjectURL(blob);

  const deptTitleForFilename =
    deptLabel && String(deptLabel).trim()
      ? String(deptLabel).trim()
      : item.department
        ? String(item.department).trim()
        : 'Department';

  const safeDeptTitle = sanitizeFilenamePart(deptTitleForFilename) || 'Department';
  const filename = `${safeDeptTitle}_section list.pdf`;

  chrome.downloads.download(
    {
      url: blobUrl,
      filename,
      saveAs: true,
    },
    () => {
      // Revoke later to avoid breaking downloads on slow systems.
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    }
  );
}

function groupByDepartment(items) {
  const map = new Map();
  for (const it of items) {
    const trimmed = String(it.department || '').trim();
    const key = trimmed || 'Unknown';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  return map;
}

function pickLatestByTimestamp(items) {
  const sorted = items
    .slice()
    .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
  return sorted[0] || null;
}

function loadData() {
  console.log('loadData called');
  
  const container = document.getElementById('data-container');
  const status = document.getElementById('status');
  
  status.textContent = 'Connecting...';
  
  try {
    chrome.runtime.sendMessage({ type: 'GET_DATA' }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('Runtime error:', chrome.runtime.lastError);
        status.textContent = 'Error: ' + chrome.runtime.lastError.message;
        container.innerHTML = '<div class="no-data">Failed to connect. Click Refresh to try again.</div>';
        return;
      }
      
      console.log('Got response:', response);

      (async () => {
        if (!(response && response.data && response.data.length > 0)) {
          status.textContent = 'No data captured yet';
          container.innerHTML = '<div class="no-data">No data captured yet. Navigate to sections pages to capture data.</div>';
          return;
        }

        const allItems = response.data;
        status.textContent = `Captured ${allItems.length} data set${allItems.length === 1 ? '' : 's'}`;

        const grouped = groupByDepartment(allItems);
        const deptCodes = Array.from(grouped.keys()).sort((a, b) => a.localeCompare(b));

        const lastSel = (await chrome.storage.local.get({ [LAST_SELECTED_DEPT_KEY]: '' }))[LAST_SELECTED_DEPT_KEY];
        const selectedDept = deptCodes.includes(lastSel) ? lastSel : deptCodes[0];

        const selectedItem = pickLatestByTimestamp(grouped.get(selectedDept) || []);
        const deptLabel = selectedDept;

        const isExpected = selectedItem && looksLikeUcamCoursesPayload(selectedItem.data);
        const courses = selectedItem ? getCoursesFromUcamPayload(selectedItem.data) : [];

        let coursesBlock = '';
        if (isExpected) {
          if (courses.length === 0) {
            coursesBlock = '<div class="no-data" style="margin-top:10px;">No courses found in this capture.</div>';
          } else {
            coursesBlock = `
              <div style="margin-top:10px;">
                <div style="margin:8px 0;"><strong>Select courses</strong></div>
                <div style="max-height:220px; overflow:auto; border:1px solid #ddd; border-radius:4px; padding:8px; background:#fff;">
                  ${courses
                    .map(
                      (c) => `
                        <label style="display:block; margin:6px 0;">
                          <input type="checkbox" class="course-check" value="${escapeHtml(c.id)}" checked />
                          <span style="margin-left:6px;">${escapeHtml(c.formalCode)}${c.courseName ? ' — ' + escapeHtml(c.courseName) : ''}</span>
                        </label>
                      `
                    )
                    .join('')}
                </div>
                <div style="margin-top:10px; text-align:center;">
                  <button id="select-all" style="padding:5px 10px;">Select All</button>
                  <button id="select-none" style="padding:5px 10px;">Select None</button>
                </div>
              </div>
            `;
          }
        } else {
          coursesBlock = '<div class="no-data" style="margin-top:10px;">This capture is not in the expected courses/sections format.</div>';
        }

        container.innerHTML = `
          <div class="data-item">
            <div style="margin-bottom:10px;">
              <div style="margin-bottom:6px;"><strong>Department</strong></div>
              <select id="dept-select" style="width:100%; padding:6px; border:1px solid #ddd; border-radius:4px;">
                ${deptCodes
                  .map((code) => {
                    return `<option value="${escapeHtml(code)}" ${code === selectedDept ? 'selected' : ''}>${escapeHtml(code)}</option>`;
                  })
                  .join('')}
              </select>
            </div>

            <div><strong>Last captured:</strong> ${selectedItem ? escapeHtml(new Date(selectedItem.timestamp).toLocaleString()) : '—'}</div>
            <div style="word-break:break-all;"><strong>URL:</strong> ${selectedItem ? escapeHtml(selectedItem.url) : '—'}</div>

            ${coursesBlock}

            <div style="margin-top:12px; text-align:center;">
              <button id="generate-selected" class="pdf-btn" style="padding:7px 14px;">Generate PDF</button>
            </div>
          </div>
        `;

        const deptSelect = document.getElementById('dept-select');
        const generateBtn = document.getElementById('generate-selected');
        const selectAllBtn = document.getElementById('select-all');
        const selectNoneBtn = document.getElementById('select-none');

        if (deptSelect) {
          deptSelect.addEventListener('change', async () => {
            await chrome.storage.local.set({ [LAST_SELECTED_DEPT_KEY]: deptSelect.value });
            loadData();
          });
        }

        function setAllChecks(checked) {
          document.querySelectorAll('.course-check').forEach((el) => {
            el.checked = checked;
          });
        }

        if (selectAllBtn) selectAllBtn.addEventListener('click', () => setAllChecks(true));
        if (selectNoneBtn) selectNoneBtn.addEventListener('click', () => setAllChecks(false));

        if (generateBtn) {
          generateBtn.addEventListener('click', () => {
            if (!selectedItem) return;
            if (isExpected) {
              const selected = Array.from(document.querySelectorAll('.course-check'))
                .filter((el) => el.checked)
                .map((el) => String(el.value));
              if (selected.length === 0) {
                alert('Please select at least one course.');
                return;
              }
              generatePdfAndDownload(selectedItem, { courseFilter: new Set(selected), departmentLabel: deptLabel });
              return;
            }
            generatePdfAndDownload(selectedItem, { departmentLabel: deptLabel });
          });
        }
      })().catch((err) => {
        console.error('UI render error:', err);
        status.textContent = 'Error: Failed to render captured data';
        container.innerHTML = '<div class="no-data">Error rendering data. Click Refresh to try again.</div>';
      });
    });
  } catch (e) {
    console.error('Exception:', e);
    status.textContent = 'Error: ' + e.message;
  }
}

function clearAll() {
  chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, (response) => {
    if (!chrome.runtime.lastError && response && response.success) {
      loadData();
    }
  });
}