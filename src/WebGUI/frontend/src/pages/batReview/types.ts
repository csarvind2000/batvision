// src/pages/batReview/types.ts

export type ReviewPayload = {
    case?: {
      patientName?: string;
      patientId?: string;
      seriesType?: string;
      status?: string;
    };
    nifti?: {
      image_b64?: string; // FAT
      image_name?: string;
  
      ff_b64?: string; // FAT FRACTION (optional)
      ff_name?: string;
  
      binary_b64?: string;
      class3_b64?: string;
      class4_b64?: string;
  
      binary_name?: string;
      class3_name?: string;
      class4_name?: string;
    };
    volumes?: {
      binary_total_ml?: number;
      class3_total_ml?: number;
      class4_total_ml?: number;
  
      class3_breakdown_ml?: {
        class1_muscle_ml?: number;
        class2_brownfat_ml?: number;
        class3_mixwhite_ml?: number;
      };
  
      class4_breakdown_ml?: {
        class1_muscle_ml?: number;
        class2_brownfat_ml?: number;
        class3_mixfat_ml?: number;
        class4_whitefat_ml?: number;
      };
    };
  };
  
  export type BaseImage = "fat" | "ff";
  export type MaskType = "binary" | "c3" | "c4";
  export type EditMode = "off" | "draw" | "erase";
