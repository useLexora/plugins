export interface ModelInfo { id: string; name: string; model_name: string; display_name?: string; recipe: string; labels: string[]; size?: number; downloaded?: boolean; [key: string]: any }
export interface LoadedModel { model_name: string; [key: string]: any }
