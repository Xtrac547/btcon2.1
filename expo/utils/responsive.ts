import { useWindowDimensions, Platform } from 'react-native';
import { useMemo } from 'react';

export type DeviceType = 'phone' | 'tablet' | 'desktop';
export type Orientation = 'portrait' | 'landscape';

export interface ResponsiveInfo {
  width: number;
  height: number;
  deviceType: DeviceType;
  orientation: Orientation;
  isPhone: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  isPortrait: boolean;
  isLandscape: boolean;
  scale: (size: number) => number;
  isSmallPhone: boolean;
  isLargePhone: boolean;
  horizontalPadding: number;
  contentMaxWidth: number;
  cardPadding: number;
  sectionGap: number;
  modalMaxWidth: number;
}

export function useResponsive(): ResponsiveInfo {
  const { width, height } = useWindowDimensions();

  return useMemo(() => {
    const isPortrait = height >= width;
    const minDimension = Math.min(width, height);
    const maxDimension = Math.max(width, height);
    
    let deviceType: DeviceType = 'phone';
    if (Platform.OS === 'web') {
      if (width >= 1024) deviceType = 'desktop';
      else if (width >= 768) deviceType = 'tablet';
    } else {
      if (minDimension >= 600) deviceType = 'tablet';
    }

    const isSmallPhone = deviceType === 'phone' && maxDimension < 700;
    const isLargePhone = deviceType === 'phone' && maxDimension >= 700;
    
    const baseWidth = 375;
    const scale = (size: number) => {
      if (deviceType === 'tablet') {
        return Math.round(size * 1.16);
      }
      if (deviceType === 'desktop') {
        return Math.round(size * 1.22);
      }
      if (isSmallPhone) {
        return Math.round(size * 0.9);
      }
      const scaleFactor = width / baseWidth;
      return Math.round(size * Math.min(scaleFactor, 1.08));
    };

    const horizontalPadding = deviceType === 'desktop' ? 32 : deviceType === 'tablet' ? 28 : isSmallPhone ? 16 : 20;
    const contentMaxWidth = deviceType === 'desktop' ? 1080 : deviceType === 'tablet' ? 820 : 680;
    const cardPadding = deviceType === 'desktop' ? 28 : deviceType === 'tablet' ? 24 : isSmallPhone ? 18 : 20;
    const sectionGap = deviceType === 'desktop' ? 24 : deviceType === 'tablet' ? 20 : 16;
    const modalMaxWidth = deviceType === 'desktop' ? 520 : deviceType === 'tablet' ? 480 : 420;

    return {
      width,
      height,
      deviceType,
      orientation: isPortrait ? 'portrait' : 'landscape',
      isPhone: deviceType === 'phone',
      isTablet: deviceType === 'tablet',
      isDesktop: deviceType === 'desktop',
      isPortrait,
      isLandscape: !isPortrait,
      scale,
      isSmallPhone,
      isLargePhone,
      horizontalPadding,
      contentMaxWidth,
      cardPadding,
      sectionGap,
      modalMaxWidth,
    };
  }, [width, height]);
}
