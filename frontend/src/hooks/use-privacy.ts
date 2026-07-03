import { create } from "zustand";

interface PrivacyState {
  blurNames: boolean;
  toggleBlurNames: () => void;
}

export const usePrivacyStore = create<PrivacyState>((set) => ({
  blurNames: false,
  toggleBlurNames: () => set((state) => ({ blurNames: !state.blurNames })),
}));
