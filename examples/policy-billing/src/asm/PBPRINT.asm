*  PBPRINT: copies statements to the print queue, adding printer
*  control for the vendor's laser line.
PBPRINT  CSECT
         STM   14,12,12(13)
         BALR  12,0
         USING *,12
         OPEN  (PRTIN,(INPUT),PRTOUT,(OUTPUT))
LOOP     GET   PRTIN,LINE
         CLI   LINE,C'1'
         BNE   COPY
         MVI   CTL,X'8B'
COPY     PUT   PRTOUT,LINE
         B     LOOP
EOF      CLOSE (PRTIN,,PRTOUT)
         LM    14,12,12(13)
         SR    15,15
         BR    14
PRTIN    DCB   DDNAME=PRTIN,DSORG=PS,MACRF=GM,EODAD=EOF
PRTOUT   DCB   DDNAME=PRTOUT,DSORG=PS,MACRF=PM
LINE     DS    CL133
CTL      DS    X
         END   PBPRINT
