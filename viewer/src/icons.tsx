/** Hand-drawn inline SVG icons (never emoji). */

export const Check = ({ size = 18, color = "#2b2925" }: { size?: number; color?: string }) => (
  <svg width={size} height={size * 0.9} viewBox="0 0 20 18" fill="none">
    <path d="M2.5 10 C 5 12, 6.5 14, 7.5 15.5 C 10 10, 13.5 5, 18 2" stroke={color} strokeWidth="2.2" strokeLinecap="round" />
  </svg>
);

export const Play = ({ size = 14, color = "#2b2925" }: { size?: number; color?: string }) => (
  <svg width={size} height={size * 1.15} viewBox="0 0 14 16" fill="none">
    <path d="M2 1.5 C 5 3, 10 6, 12.5 8 C 10 10, 5 13, 2 14.5 C 1.8 10, 1.8 6, 2 1.5 Z" stroke={color} strokeWidth="1.7" strokeLinejoin="round" />
  </svg>
);

export const Stop = ({ size = 13, color = "#2b2925" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
    <rect x="1.8" y="1.8" width="10.4" height="10.4" rx="2.5" stroke={color} strokeWidth="1.8" />
  </svg>
);

export const Folder = ({ size = 19, color = "#2b2925" }: { size?: number; color?: string }) => (
  <svg width={size} height={size * 0.84} viewBox="0 0 19 16" fill="none">
    <path
      d="M1.5 4 C1.5 3, 2 2, 3 2 L7 2 L9 4.5 L16 4.5 C17 4.5, 17.5 5, 17.5 6 L17.5 12.5 C17.5 13.5, 17 14, 16 14 L3 14 C2 14, 1.5 13.5, 1.5 12.5 Z"
      stroke={color}
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
  </svg>
);

export const FileIcon = ({ size = 12, color = "#2b2925" }: { size?: number; color?: string }) => (
  <svg width={size} height={size * 1.18} viewBox="0 0 11 13" fill="none">
    <path d="M1.5 1.5 L7 1.5 L9.5 4 L9.5 11.5 L1.5 11.5 Z M7 1.5 L7 4 L9.5 4" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

export const Redo = ({ size = 15, color = "#2b2925" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <path
      d="M13.5 6.5 C 12.5 3.5, 10 2, 7.5 2 C 4.5 2, 2 4.5, 2 7.5 C 2 10.5, 4.5 13, 7.5 13 C 10 13, 12 11.5, 13 9.5 M13.5 2.5 L 13.5 6.5 L 9.5 6.5"
      stroke={color}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const Pencil = ({ size = 16, color = "#2b2925" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 18 18" fill="none">
    <path d="M2 16 L3 12 L12.5 2.5 C13.5 1.5, 15.5 3.5, 14.5 4.5 L5 14 Z M11.5 3.5 L13.5 5.5" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
  </svg>
);

export const X = ({ size = 15, color = "#8a857c" }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 15 15" fill="none">
    <path d="M2.5 2.5 C 6 6, 9 9, 12.5 12.5 M12.5 2.5 C 9 6, 6 9, 2.5 12.5" stroke={color} strokeWidth="1.7" strokeLinecap="round" />
  </svg>
);

export const Box = ({ checked, accent, dashed }: { checked?: boolean; accent?: boolean; dashed?: boolean }) => (
  <svg width="17" height="17" viewBox="0 0 17 17" fill="none" style={{ flex: "none" }}>
    <rect
      x="1.5"
      y="1.5"
      width="14"
      height="14"
      rx="3"
      stroke={accent ? "#c2410c" : dashed ? "#8a857c" : "#2b2925"}
      strokeWidth={accent ? 1.7 : 1.5}
      strokeDasharray={dashed ? "3 3" : undefined}
    />
    {checked && <path d="M4 8.5 C 6 10, 7 11.5, 7.5 12.5 C 9 9, 11 5.5, 14 3.5" stroke="#2b2925" strokeWidth="1.8" strokeLinecap="round" />}
  </svg>
);
