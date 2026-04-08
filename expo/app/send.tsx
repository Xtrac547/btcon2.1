import '@/utils/shim';
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ActivityIndicator, ScrollView, useWindowDimensions, Platform } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useWallet } from '@/contexts/WalletContext';
import { useNotifications } from '@/contexts/NotificationContext';
import { useDeveloperHierarchy } from '@/contexts/DeveloperHierarchyContext';
import { ArrowLeft, Send, X, Camera, RefreshCw, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useResponsive } from '@/utils/responsive';
import { btconToEuro, useBtcPrice } from '@/services/btcPrice';

interface RecommendedFees {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  minimumFee: number;
}

const FEE_REFRESH_INTERVAL = 30_000;
const DUST_LIMIT = 546;


export default function SendScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    preselectedAmount?: string;
    address?: string;
  }>();
  const { balance, signAndBroadcastTransaction, estimateTransactionCosts, esploraService, address } = useWallet();
  const { notifyTransaction, notifyPendingTransaction } = useNotifications();
  const { isDeveloper } = useDeveloperHierarchy();
  const { width } = useWindowDimensions();
  const responsive = useResponsive();
  const scrollViewRef = useRef<ScrollView>(null);
  const [toAddress, setToAddress] = useState(params.address || '');
  const [isSending, setIsSending] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [hasScanned, setHasScanned] = useState(false);
  const [amountBtcon, setAmountBtcon] = useState<number>(params.preselectedAmount ? parseInt(params.preselectedAmount, 10) : 0);
  const [feeDetails, setFeeDetails] = useState<{
    networkFee: number;
    totalFee: number;
    totalDebit: number;
    feeRate: number;
    vSize: number;
    inputCount: number;
  } | null>(null);
  const [isEstimatingFees, setIsEstimatingFees] = useState(false);
  const [recommendedFees, setRecommendedFees] = useState<RecommendedFees | null>(null);
  const [isLoadingFees, setIsLoadingFees] = useState(false);
  const [feeStale, setFeeStale] = useState(false);
  const [lastFeeRefresh, setLastFeeRefresh] = useState<number>(0);
  const [showFeeDetails, setShowFeeDetails] = useState(false);
  const { btcPrice } = useBtcPrice();
  const feeRefreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);


  const totalAmount = amountBtcon;

  const fetchRecommendedFees = useCallback(async () => {
    setIsLoadingFees(true);
    try {
      console.log('[Fees] Fetching recommended fees...');
      const fees = await esploraService.getRecommendedFees();
      console.log('[Fees] Got recommended fees:', JSON.stringify(fees));
      setRecommendedFees(fees);
      setLastFeeRefresh(Date.now());
      setFeeStale(false);
      return fees;
    } catch (error) {
      console.error('[Fees] Failed to fetch recommended fees:', error);
      setFeeStale(true);
      return null;
    } finally {
      setIsLoadingFees(false);
    }
  }, [esploraService]);

  useEffect(() => {
    void fetchRecommendedFees();

    feeRefreshTimerRef.current = setInterval(() => {
      void fetchRecommendedFees();
    }, FEE_REFRESH_INTERVAL);

    return () => {
      if (feeRefreshTimerRef.current) {
        clearInterval(feeRefreshTimerRef.current);
      }
    };
  }, [fetchRecommendedFees]);



  const baseFeeRate = useMemo(() => {
    return recommendedFees?.halfHourFee ?? 0;
  }, [recommendedFees]);

  const selectedFeeRate = baseFeeRate;

  useEffect(() => {
    const updateFees = async () => {
      if (totalAmount <= 0 || selectedFeeRate <= 0) {
        setFeeDetails(null);
        return;
      }

      setIsEstimatingFees(true);
      let success = false;

      try {
        if (address) {
          const estimate = await estimateTransactionCosts(Math.floor(totalAmount), selectedFeeRate);
          const vSize = esploraService.estimateVSize(estimate.selectedInputs, 2, 'p2wpkh');
          setFeeDetails({
            networkFee: estimate.networkFee,
            totalFee: estimate.totalFee,
            totalDebit: estimate.totalDebit,
            feeRate: estimate.feeRate,
            vSize,
            inputCount: estimate.selectedInputs,
          });
          success = true;
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.log('[Fees] UTXO-based estimation failed:', msg);
      }

      if (!success) {
        try {
          console.log('[Fees] Using formula-based fallback with rate:', selectedFeeRate);
          const { feeSats, txSize } = esploraService.estimateFeesFromRate(selectedFeeRate, 1, 2);
          const totalDebit = Math.floor(totalAmount) + feeSats;

          setFeeDetails({
            networkFee: feeSats,
            totalFee: feeSats,
            totalDebit,
            feeRate: selectedFeeRate,
            vSize: txSize,
            inputCount: 1,
          });
        } catch (fallbackError) {
          console.error('[Fees] All fee estimation failed:', fallbackError);
          setFeeDetails(null);
        }
      }

      setIsEstimatingFees(false);
    };

    void updateFees();
  }, [totalAmount, address, estimateTransactionCosts, esploraService, selectedFeeRate]);

  const addressValid = useMemo(() => {
    const addr = toAddress.trim();
    if (!addr) return null;
    if (addr.startsWith('bc1q') || addr.startsWith('bc1p')) return true;
    if (addr.startsWith('1') || addr.startsWith('3')) return true;
    if (addr.startsWith('tb1') || addr.startsWith('m') || addr.startsWith('n') || addr.startsWith('2')) return true;
    return false;
  }, [toAddress]);

  const canSend = useMemo(() => {
    if (!toAddress.trim()) return false;
    if (addressValid === false) return false;
    if (totalAmount <= 0) return false;
    if (totalAmount < DUST_LIMIT) return false;
    if (!feeDetails) return false;
    if (feeDetails.totalDebit > balance) return false;
    if (isEstimatingFees) return false;
    return true;
  }, [toAddress, addressValid, totalAmount, feeDetails, balance, isEstimatingFees]);

  const sendDisabledReason = useMemo((): string | null => {
    if (!toAddress.trim()) return 'Adresse requise';
    if (addressValid === false) return 'Adresse invalide';
    if (totalAmount <= 0) return 'Montant requis';
    if (totalAmount < DUST_LIMIT) return `Minimum: ${(DUST_LIMIT / 100_000_000).toFixed(8)} Btcon`;
    if (isEstimatingFees) return 'Calcul des frais...';
    if (!feeDetails) return 'Frais indisponibles';
    if (feeDetails.totalDebit > balance) return `Fonds insuffisants (manque ${((feeDetails.totalDebit - balance) / 100_000_000).toFixed(8)} Btcon)`;
    return null;
  }, [toAddress, addressValid, totalAmount, feeDetails, balance, isEstimatingFees]);

  const handleSend = async () => {
    const input = toAddress.trim();
    
    if (!canSend || !feeDetails) {
      if (sendDisabledReason) {
        Alert.alert('Impossible', sendDisabledReason);
      }
      return;
    }

    const resolvedAddress = input;
    const btconAmount = totalAmount;
    const satsAmount = Math.floor(btconAmount);

    const feeBtc = (feeDetails.networkFee / 100_000_000).toFixed(8);
    const feeEur = btconToEuro(feeDetails.networkFee, btcPrice);
    const totalBtc = (feeDetails.totalDebit / 100_000_000).toFixed(8);
    const totalEur = btconToEuro(feeDetails.totalDebit, btcPrice);

    Alert.alert(
      'Confirmer la transaction',
      `Destinataire: ${resolvedAddress.slice(0, 12)}...${resolvedAddress.slice(-6)}\n\nMontant: ${(satsAmount / 100_000_000).toFixed(8)} Btcon\n\nFrais réseau: ${feeBtc} Btcon ≈ ${feeEur}€\nTaux: ${feeDetails.feeRate} sat/vB | ${feeDetails.vSize} vB\n\nTotal débité: ${totalBtc} Btcon ≈ ${totalEur}€`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Confirmer',
          onPress: async () => {
            setIsSending(true);
            try {
              const txid = await signAndBroadcastTransaction(resolvedAddress, satsAmount, selectedFeeRate);
              const explorerUrl = esploraService.getExplorerUrl(txid);
              
              await notifyTransaction('sent', btconAmount);
              await notifyPendingTransaction({ type: 'sent', amount: btconAmount });
              
              Alert.alert(
                'Transaction envoyée ✓',
                `TX: ${txid.slice(0, 16)}...\n\nExplorer: ${explorerUrl}`,
                [{ text: 'OK', onPress: () => router.back() }]
              );

              setToAddress('');
            } catch (error) {
              console.error('Error sending transaction:', error);
              Alert.alert('Erreur', error instanceof Error ? error.message : 'Échec de la transaction');
            } finally {
              setIsSending(false);
            }
          },
        },
      ]
    );
  };

  const handleOpenCamera = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        Alert.alert('Permission refusée', 'Veuillez autoriser l\'accès à la caméra');
        return;
      }
    }
    setHasScanned(false);
    setShowCamera(true);
  };

  const handleBarcodeScanned = useCallback((data: string) => {
    if (hasScanned) return;
    setHasScanned(true);
    setShowCamera(false);
    
    console.log('QR Code scanné:', data);
    
    let extractedAddress = decodeURIComponent(data).trim();
    let extractedAmount = 0;
    
    if (extractedAddress.toLowerCase().startsWith('bitcoin:')) {
      const uri = extractedAddress.substring(8);
      const parts = uri.split('?');
      extractedAddress = parts[0];
      
      if (parts.length > 1) {
        const qsParams = new URLSearchParams(parts[1]);
        const amountBtc = qsParams.get('amount');
        
        if (amountBtc) {
          extractedAmount = Math.floor(parseFloat(amountBtc) * 100000000);
        }
      }
    }
    
    setToAddress(extractedAddress);
    
    if (extractedAmount > 0) {
      setAmountBtcon(extractedAmount);
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [hasScanned, scrollViewRef]);

  const formatBtconDisplay = useCallback((sats: number): string => {
    return `${(sats / 100_000_000).toFixed(8)} Btcon`;
  }, []);

  const timeSinceRefresh = useMemo(() => {
    if (!lastFeeRefresh) return '';
    const seconds = Math.floor((Date.now() - lastFeeRefresh) / 1000);
    if (seconds < 5) return 'à l\'instant';
    if (seconds < 60) return `il y a ${seconds}s`;
    return `il y a ${Math.floor(seconds / 60)}min`;
  }, [lastFeeRefresh]);

  return (
    <View style={styles.container}>
      <View style={styles.backgroundPattern}>
        {[...Array(20)].map((_, i) => (
          <View
            key={`pattern-${i}`}
            style={[
              i % 3 === 0 ? styles.patternCircle : styles.patternSquare,
              {
                width: 40 + (i % 3) * 30,
                height: 40 + (i % 3) * 30,
                left: (i * 70) % width,
                top: Math.floor(i / 4) * 180 + 50,
                transform: [{ rotate: `${i * 15}deg` }],
              },
            ]}
          />
        ))}
      </View>
      <View style={[styles.header, { paddingHorizontal: responsive.horizontalPadding, paddingTop: responsive.isDesktop ? 36 : responsive.isTablet ? 44 : 60 }]}> 
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <ArrowLeft color="#FFF" size={24} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Envoyer</Text>
        <View style={styles.placeholder} />
      </View>

      <ScrollView 
        ref={scrollViewRef}
        style={styles.scrollView} 
        contentContainerStyle={[styles.content, { paddingHorizontal: responsive.horizontalPadding, maxWidth: responsive.contentMaxWidth, alignSelf: 'center', width: '100%' }]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.formCard, { padding: responsive.cardPadding }]}> 
          <View style={styles.inputContainer}>
            <Text style={styles.inputLabel}>Destinataire</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={[
                  styles.input,
                  addressValid === false && styles.inputError,
                  addressValid === true && styles.inputValid,
                ]}
                value={toAddress}
                onChangeText={setToAddress}
                placeholder="Adresse Bitcoin (bc1q...)"
                placeholderTextColor="#555"
                autoCapitalize="none"
                autoCorrect={false}
                testID="recipient-input"
              />
            </View>
            {addressValid === false && (
              <View style={styles.validationRow}>
                <AlertTriangle color="#FF4444" size={12} />
                <Text style={styles.validationError}>Adresse invalide</Text>
              </View>
            )}
            {addressValid === true && toAddress.startsWith('bc1q') && (
              <Text style={styles.validationSuccess}>SegWit natif (P2WPKH)</Text>
            )}
            {addressValid === true && toAddress.startsWith('bc1p') && (
              <Text style={styles.validationSuccess}>Taproot (P2TR)</Text>
            )}
          </View>
        </View>

        {totalAmount > 0 && (
          <View style={styles.totalContainer}>
            <Text style={styles.totalLabel}>Montant</Text>
            <View style={styles.totalRow}>
              <Text style={[styles.totalAmount, { fontSize: responsive.scale(32) }]}>{totalAmount.toLocaleString()}</Text>
              <Text style={[styles.totalUnit, { fontSize: responsive.scale(14) }]}>Btcon</Text>
            </View>
            <Text style={styles.totalEuroHint}>≈ {btconToEuro(totalAmount, btcPrice)}€</Text>
          </View>
        )}

        {totalAmount > 0 && recommendedFees && (
          <View style={styles.feeRateCard}>
            <View style={styles.feeRateHeader}>
              <Text style={styles.feeRateTitle}>Taux réseau</Text>
              <TouchableOpacity
                style={styles.refreshButton}
                onPress={() => void fetchRecommendedFees()}
                disabled={isLoadingFees}
                testID="refresh-fees-button"
              >
                {isLoadingFees ? (
                  <ActivityIndicator color="#FF8C00" size="small" />
                ) : (
                  <RefreshCw color={feeStale ? '#FF4444' : '#666'} size={16} />
                )}
              </TouchableOpacity>
            </View>
            {feeStale && (
              <View style={styles.staleWarning}>
                <AlertTriangle color="#FFaa00" size={12} />
                <Text style={styles.staleWarningText}>Taux peut-être obsolète</Text>
              </View>
            )}
            <View style={styles.feeRateValue}>
              <Text style={styles.feeRateNumber}>{selectedFeeRate}</Text>
              <Text style={styles.feeRateUnit}>sat/vB</Text>
            </View>
            {timeSinceRefresh ? (
              <Text style={styles.refreshTimestamp}>Mis à jour {timeSinceRefresh}</Text>
            ) : null}
          </View>
        )}

        {totalAmount > 0 && (
          <View style={[styles.feesCard, { padding: responsive.cardPadding }]}> 
            <View style={styles.feesRow}>
              <Text style={styles.feesTransactionLabel}>Frais de transaction</Text>
              {isEstimatingFees ? (
                <ActivityIndicator color="#FF8C00" />
              ) : (
                <View style={styles.feesRightColumn}>
                  <Text style={styles.feesValueBig}>
                    {feeDetails ? formatBtconDisplay(feeDetails.networkFee) : '...'}
                  </Text>
                  {feeDetails && (
                    <Text style={styles.feesEuroValue}>≈ {btconToEuro(feeDetails.networkFee, btcPrice)}€</Text>
                  )}
                </View>
              )}
            </View>

            <View style={styles.feesDivider} />

            <TouchableOpacity
              style={styles.feesRow}
              onPress={() => setShowFeeDetails(!showFeeDetails)}
              activeOpacity={0.7}
            >
              <View style={styles.detailsToggle}>
                <Text style={styles.feesLeftLabel}>Détails techniques</Text>
                {showFeeDetails ? (
                  <ChevronUp color="#666" size={14} />
                ) : (
                  <ChevronDown color="#666" size={14} />
                )}
              </View>
              <View style={styles.feesRightColumn}>
                <Text style={styles.feesValueBig}>{feeDetails?.feeRate ?? '...'} sat/vB</Text>
              </View>
            </TouchableOpacity>

            {showFeeDetails && feeDetails && (
              <View style={styles.technicalDetails}>
                <View style={styles.techRow}>
                  <Text style={styles.techLabel}>Taille estimée (vSize)</Text>
                  <Text style={styles.techValue}>{feeDetails.vSize} vBytes</Text>
                </View>
                <View style={styles.techRow}>
                  <Text style={styles.techLabel}>Inputs utilisés</Text>
                  <Text style={styles.techValue}>{feeDetails.inputCount} UTXO{feeDetails.inputCount > 1 ? 's' : ''}</Text>
                </View>
                <View style={styles.techRow}>
                  <Text style={styles.techLabel}>Type d'adresse</Text>
                  <Text style={styles.techValue}>P2WPKH (SegWit natif)</Text>
                </View>
                <View style={styles.techRow}>
                  <Text style={styles.techLabel}>Calcul</Text>
                  <Text style={styles.techValue}>{feeDetails.vSize} × {feeDetails.feeRate} = {formatBtconDisplay(feeDetails.networkFee)}</Text>
                </View>
                <View style={styles.techRow}>
                  <Text style={styles.techLabel}>En BTC</Text>
                  <Text style={styles.techValue}>{(feeDetails.networkFee / 100_000_000).toFixed(8)} Btcon</Text>
                </View>
              </View>
            )}

            <View style={styles.feesDivider} />

            <View style={styles.feesRow}>
              <Text style={[styles.feesLeftLabel, { fontWeight: '800' as const }]}>Total à déduire</Text>
              <View style={styles.feesRightColumn}>
                <Text style={[styles.feesValueBig, { fontSize: 18 }]}>
                  {feeDetails ? formatBtconDisplay(feeDetails.totalDebit) : '...'}
                </Text>
                {feeDetails && (
                  <>
                    <Text style={styles.feesEuroValue}>= {(feeDetails.totalDebit / 100_000_000).toFixed(8)} Btcon</Text>
                    <Text style={styles.feesEuroValue}>≈ {btconToEuro(feeDetails.totalDebit, btcPrice)}€</Text>
                  </>
                )}
              </View>
            </View>

            {feeDetails && feeDetails.totalDebit > balance && (
              <View style={styles.insufficientWarning}>
                <AlertTriangle color="#FF4444" size={14} />
                <Text style={styles.insufficientText}>
                  Fonds insuffisants (manque {((feeDetails.totalDebit - balance) / 100_000_000).toFixed(8)} Btcon)
                </Text>
              </View>
            )}
          </View>
        )}

        {!showCamera && (
          <View style={[styles.actionButtonsRow, { width: '100%' }]}> 
            <TouchableOpacity
              style={styles.cameraButton}
              onPress={handleOpenCamera}
              testID="scan-qr-button"
            >
              <Camera color="#FF8C00" size={24} />
              <Text style={styles.cameraButtonText}>Scanner QR Code</Text>
            </TouchableOpacity>
          </View>
        )}

        {showCamera && (
          <View style={styles.cameraContainer}>
            <View style={styles.cameraHeaderInline}>
              <Text style={styles.cameraTitle}>Scanner QR Code</Text>
              <TouchableOpacity
                onPress={() => setShowCamera(false)}
                style={styles.closeCameraButton}
                testID="close-camera-button"
              >
                <X color="#FFF" size={24} />
              </TouchableOpacity>
            </View>
            <CameraView
              style={styles.cameraView}
              facing="back"
              barcodeScannerSettings={{
                barcodeTypes: ['qr'],
              }}
              onBarcodeScanned={(result: { data?: string }) => {
                if (result?.data) {
                  handleBarcodeScanned(result.data);
                }
              }}
            >
              <View style={styles.scannerOverlay}>
                <View style={styles.scannerFrame} />
              </View>
            </CameraView>
          </View>
        )}

        <TouchableOpacity
          style={[
            styles.sendButton,
            { alignSelf: 'center', width: '100%', maxWidth: responsive.isDesktop ? 520 : responsive.isTablet ? 460 : undefined },
            (!canSend || isSending) && styles.sendButtonDisabled,
          ]}
          onPress={handleSend}
          disabled={!canSend || isSending}
          testID="send-transaction-button"
        >
          {isSending ? (
            <ActivityIndicator color="#FFF" />
          ) : (
            <>
              <Send color="#FFF" size={20} />
              <Text style={styles.sendButtonText}>
                {sendDisabledReason ?? 'Envoyer'}
              </Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
    position: 'relative' as const,
  },
  backgroundPattern: {
    position: 'absolute' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0.06,
  },
  patternCircle: {
    position: 'absolute' as const,
    borderRadius: 1000,
    borderWidth: 3,
    borderColor: '#FF8C00',
  },
  patternSquare: {
    position: 'absolute' as const,
    borderWidth: 3,
    borderColor: '#FFD700',
    borderRadius: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 60,
    paddingBottom: 16,
  },
  backButton: {
    padding: 8,
  },
  headerTitle: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: '700' as const,
  },
  placeholder: {
    width: 40,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    paddingVertical: 12,
    paddingBottom: 40,
  },
  formCard: {
    backgroundColor: '#0f0f0f',
    borderRadius: 28,
    padding: 28,
    marginBottom: 0,
    gap: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  inputContainer: {
    gap: 8,
  },
  inputLabel: {
    color: '#999',
    fontSize: 12,
    fontWeight: '600' as const,
  },
  inputRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  input: {
    flex: 1,
    backgroundColor: '#000000',
    borderRadius: 16,
    padding: 18,
    color: '#FFFFFF',
    fontSize: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  inputError: {
    borderColor: 'rgba(255, 68, 68, 0.5)',
  },
  inputValid: {
    borderColor: 'rgba(0, 204, 102, 0.3)',
  },
  validationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  validationError: {
    color: '#FF4444',
    fontSize: 11,
    fontWeight: '600' as const,
  },
  validationSuccess: {
    color: '#00CC66',
    fontSize: 11,
    fontWeight: '600' as const,
  },
  totalContainer: {
    marginTop: 20,
    padding: 20,
    backgroundColor: 'rgba(61, 40, 25, 0.8)',
    borderRadius: 16,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255, 140, 0, 0.4)',
  },
  totalLabel: {
    color: '#FFF',
    fontSize: 14,
    marginBottom: 8,
    fontWeight: '600' as const,
  },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  totalAmount: {
    color: '#FFF',
    fontSize: 32,
    fontWeight: '900' as const,
  },
  totalUnit: {
    color: '#FF8C00',
    fontSize: 14,
    fontWeight: '900' as const,
  },
  totalEuroHint: {
    color: '#999',
    fontSize: 13,
    marginTop: 6,
    fontWeight: '500' as const,
  },
  feeRateCard: {
    backgroundColor: '#0f0f0f',
    borderRadius: 20,
    padding: 20,
    marginTop: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  feeRateHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  feeRateTitle: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '700' as const,
  },
  feeRateValue: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    justifyContent: 'center',
    paddingVertical: 8,
  },
  feeRateNumber: {
    color: '#FF8C00',
    fontSize: 28,
    fontWeight: '900' as const,
  },
  feeRateUnit: {
    color: '#999',
    fontSize: 14,
    fontWeight: '600' as const,
  },
  refreshButton: {
    padding: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
  },
  staleWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255, 170, 0, 0.1)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 12,
  },
  staleWarningText: {
    color: '#FFaa00',
    fontSize: 11,
    fontWeight: '600' as const,
  },

  refreshTimestamp: {
    color: '#444',
    fontSize: 10,
    textAlign: 'center' as const,
    marginTop: 10,
  },

  feesCard: {
    backgroundColor: '#0f0f0f',
    borderRadius: 20,
    padding: 24,
    marginTop: 16,
    borderWidth: 2,
    borderColor: 'rgba(255, 140, 0, 0.3)',
    shadowColor: '#FF8C00',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 4,
    alignItems: 'center',
  },
  feesRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
  },
  feesTransactionLabel: {
    color: '#999',
    fontSize: 14,
    fontWeight: '600' as const,
  },
  feesLeftLabel: {
    color: '#999',
    fontSize: 14,
    fontWeight: '600' as const,
  },
  feesRightColumn: {
    alignItems: 'flex-end',
  },
  feesValueBig: {
    color: '#FF8C00',
    fontSize: 16,
    fontWeight: '900' as const,
  },
  feesEuroValue: {
    color: '#666',
    fontSize: 12,
    fontWeight: '600' as const,
    marginTop: 2,
  },
  feesDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 140, 0, 0.15)',
    marginVertical: 16,
    width: '100%',
  },
  detailsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  technicalDetails: {
    width: '100%',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    borderRadius: 12,
    padding: 14,
    marginTop: 12,
    gap: 8,
  },
  techRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  techLabel: {
    color: '#666',
    fontSize: 11,
    fontWeight: '500' as const,
  },
  techValue: {
    color: '#999',
    fontSize: 11,
    fontWeight: '700' as const,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  insufficientWarning: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255, 68, 68, 0.1)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 12,
    width: '100%',
  },
  insufficientText: {
    color: '#FF4444',
    fontSize: 12,
    fontWeight: '600' as const,
    flex: 1,
  },
  actionButtonsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 24,
    marginTop: 16,
  },
  cameraButton: {
    flex: 1,
    backgroundColor: '#0f0f0f',
    borderRadius: 20,
    padding: 20,
    alignItems: 'center',
    gap: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
    borderWidth: 1,
    borderColor: 'rgba(255, 140, 0, 0.15)',
  },
  cameraButtonText: {
    color: '#FF8C00',
    fontSize: 13,
    fontWeight: '700' as const,
    letterSpacing: 0.3,
  },
  sendButton: {
    backgroundColor: '#FF8C00',
    borderRadius: 20,
    padding: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 20,
    marginTop: 8,
    shadowColor: '#FF8C00',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 8,
  },
  sendButtonDisabled: {
    opacity: 0.4,
    backgroundColor: '#555',
    shadowOpacity: 0,
  },
  sendButtonText: {
    color: '#FFF',
    fontSize: 15,
    fontWeight: '800' as const,
    letterSpacing: 0.3,
  },
  cameraContainer: {
    backgroundColor: '#0f0f0f',
    borderRadius: 28,
    overflow: 'hidden',
    marginBottom: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 140, 0, 0.2)',
  },
  cameraHeaderInline: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#000',
  },
  cameraTitle: {
    color: '#FFF',
    fontSize: 18,
    fontWeight: '700' as const,
  },
  closeCameraButton: {
    padding: 8,
    backgroundColor: 'rgba(255, 140, 0, 0.2)',
    borderRadius: 12,
  },
  cameraView: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: '#000',
  },
  scannerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  scannerFrame: {
    width: '80%',
    aspectRatio: 1,
    maxWidth: 340,
    maxHeight: 340,
    borderWidth: 4,
    borderColor: '#FF8C00',
    borderRadius: 32,
    backgroundColor: 'transparent',
    shadowColor: '#FF8C00',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 20,
    elevation: 10,
  },
});
