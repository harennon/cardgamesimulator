import axios, { type AxiosInstance } from "axios";
import { getAccessToken } from "@/service/authService";

export const axiosInstance: AxiosInstance = axios.create({});

axiosInstance.interceptors.request.use(async (config) => {
  const token = await getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});
